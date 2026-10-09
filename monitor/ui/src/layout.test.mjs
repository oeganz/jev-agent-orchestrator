// Tests for monitor/ui/src/layout.js. Pure layout, no DOM.
//
// Two acceptance items:
//   (a) on a synthetic graph of 6 folders with 1..12 members each, no two
//       padded hull boxes intersect and the min gap >= 24 px;
//   (b) every member lies inside its own folder's padded hull box;
//   (c) same for the REAL graph: a fixture saved from `GET /graph` on a
//       running monitor/server.mjs bound to MONITOR_PORT=8802.
//
// Run with:  node --test monitor/ui/src/layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { computeLayout, separateGroups, separateCardsGlobal, hullsFromPositions, _internals } from './layout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(dirname(HERE)));                 // worktree root
const SERVER = join(REPO, 'monitor', 'server.mjs');

// --- helpers ---

// Synthetic graph: 6 folders, member counts 1..12 (one per folder). Each
// member is a session with a unique id, parent = its folder node. Edges
// are the tree edges (folder->member).
function makeSynthetic() {
  const counts = [1, 12, 4, 9, 3, 6];   // 6 folders, varied crowd
  const nodes = [];
  const edges = [];
  counts.forEach((n, fi) => {
    const folder = 'C:/repos/folder-' + fi;
    const fid = 'folder:f' + fi;
    nodes.push({ id: fid, kind: 'folder', folder, branch: null, parent: null });
    for (let i = 0; i < n; i++) {
      const sid = 's' + fi + '-' + i;
      nodes.push({ id: sid, kind: 'session', folder, branch: 'main', parent: fid });
      edges.push({ id: 'tree:' + fid + '>' + sid, from: fid, to: sid, kind: 'tree' });
    }
  });
  return { nodes, edges };
}

// Gap between two axis-aligned rectangles (0 when they touch or overlap;
// positive when they're disjoint).
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

function checkHulls(layout, { gap = 24, tolerance = 0.5 } = {}) {
  // (a) disjoint with min gap. The simulation converges to within a
  // sub-pixel of GROUP_MIN_GAP; the tolerance absorbs floating-point
  // drift so the test is deterministic across seeds.
  for (let i = 0; i < layout.hulls.length; i++) {
    for (let j = i + 1; j < layout.hulls.length; j++) {
      const a = layout.hulls[i], b = layout.hulls[j];
      const g = rectGap(a, b);
      assert.ok(g + tolerance >= gap,
        `hulls ${a.key} and ${b.key} gap ${g.toFixed(2)} < ${gap} (tolerance ${tolerance})\n` +
        `a=(${a.x.toFixed(1)},${a.y.toFixed(1)},${a.w.toFixed(1)}x${a.h.toFixed(1)})\n` +
        `b=(${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w.toFixed(1)}x${b.h.toFixed(1)})`);
    }
  }
  // (b) every member is inside its own hull
  for (const hull of layout.hulls) {
    for (const id of hull.members) {
      const p = layout.positions.get(id);
      assert.ok(p, `position for ${id} missing`);
      const inside =
        p.x >= hull.x && p.x <= hull.x + hull.w &&
        p.y >= hull.y && p.y <= hull.y + hull.h;
      assert.ok(inside,
        `${id} at (${p.x.toFixed(1)},${p.y.toFixed(1)}) outside hull ${hull.key} ` +
        `(${hull.x.toFixed(1)},${hull.y.toFixed(1)},${hull.w.toFixed(1)}x${hull.h.toFixed(1)})`);
    }
  }
}

// --- 1: synthetic ---

test('synthetic 6-folder graph: padded hulls disjoint with gap >= 24, members inside own hull', () => {
  const { nodes, edges } = makeSynthetic();
  // Deterministic RNG so a regression is reproducible.
  let s = 1234567;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0xffffffff) / 0x100000000; };
  const layout = computeLayout(nodes, edges, { width: 1800, height: 1400, rng, ticks: 600 });
  // We expect 6 hulls (one per folder) because every folder has >= 1 member.
  assert.equal(layout.hulls.length, 6, 'one hull per folder');
  checkHulls(layout);
});

// --- 2: real graph (fixture from running server.mjs on :8802) ---

const REAL_PORT = 8802;                                // local-only port, NEVER 8790

async function fetchFixture() {
  // Start the server on REAL_PORT. Caller is responsible for cleanup.
  const env = { ...process.env, MONITOR_PORT: String(REAL_PORT) };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore', detached: true });
  proc.unref();
  // Wait for the first tick.
  const deadline = Date.now() + 12000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + REAL_PORT + '/graph');
      if (r.ok) {
        const j = await r.json();
        return { graph: j, proc };
      }
      lastErr = new Error('status ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server did not answer on /graph within 12s: ' + (lastErr && lastErr.message));
}

async function killProc(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill(); } catch { /* already gone */ }
  // Give Windows a moment to release the port.
  await new Promise((r) => setTimeout(r, 500));
}

function killByPort(port) {
  // Best-effort: netstat + taskkill. Never touches 8790.
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).filter((l) => l.includes(':' + port + ' '));
    const pids = new Set();
    for (const l of lines) {
      const m = l.match(/\s(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      try { execFileSync('taskkill', ['//PID', pid, '//F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  } catch { /* netstat may be unavailable; ignore */ }
}

test('real graph from /graph: padded hulls disjoint with gap >= 24, members inside own hull', async () => {
  let proc;
  try {
    const { graph, proc: p } = await fetchFixture();
    proc = p;
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    // Save the fixture under /tmp for the node -e paste-of-record step in
    // the dispatch preamble. Windows + Git Bash: node cannot open /tmp paths;
    // use cygpath -m to get a Windows-style tmp path that survives the shell.
    const tmpDir = process.env.TMP || process.env.TEMP || tmpdir();
    const fixturePath = join(tmpDir, 'monitor-graph-fixture.json');
    writeFileSync(fixturePath, JSON.stringify(graph));
    // Bail early (with a friendly message) when the live graph is empty —
    // no synthetic data is available without Orca running. The property
    // still holds vacuously.
    if (nodes.length === 0) {
      assert.ok(true, 'live graph is empty (no Orca fleet data on this host); vacuously true');
      return;
    }
    const layout = computeLayout(nodes, edges, { width: 1800, height: 1400, ticks: 600 });
    assert.ok(layout.hulls.length >= 1, 'at least one hull when nodes exist');
    checkHulls(layout);
  } finally {
    await killProc(proc);
    killByPort(REAL_PORT);
  }
});

// ---- per-poll separation: separateGroups + separateCardsGlobal ----
//
// These are the helpers reconcilePositions calls every poll. The contract
// is "no overlap, ever, even when something has been dragged" — and the
// helpers must satisfy it without moving any pinned id.

test('separateGroups: hulls that were dragged together are pushed back to >= 24 px', () => {
  // Build a 3-folder graph and run a full layout. Then COLLAPSE two hulls
  // on top of each other (simulating a manual drag) and call separateGroups.
  // After: the gap must be back to GROUP_MIN_GAP.
  const nodes = [];
  const edges = [];
  for (let f = 0; f < 3; f++) {
    const fid = `folder:f${f}`;
    nodes.push({ id: fid, kind: 'folder', folder: `C:/r/f${f}`, parent: null });
    for (let a = 0; a < 2; a++) {
      const id = `f${f}a${a}`;
      nodes.push({ id, kind: 'agent', folder: `C:/r/f${f}`, parent: fid });
      edges.push({ id: `e-${id}`, from: fid, to: id, kind: 'tree' });
    }
  }
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Force hull-0 and hull-1 to overlap (we drop hull-1 onto hull-0's
  // position). The helper must repair it on the next call.
  const p0 = seed.positions.get('folder:f0');
  const f1members = seed.hulls.find((h) => h.key === 'c:/r/f1').members;
  for (const id of f1members) {
    const p = seed.positions.get(id);
    p.x = p0.x + (p.x - seed.positions.get('folder:f1').x);
    p.y = p0.y + (p.y - seed.positions.get('folder:f1').y);
  }
  // The folder hub position also moves so translateGroup() has the right
  // delta reference (computeLayout pins folder hubs inside their group).
  const p1 = seed.positions.get('folder:f1');
  const dx = p0.x - p1.x, dy = p0.y - p1.y;
  p1.x = p0.x; p1.y = p0.y;
  // Refresh hulls from positions, then run separateGroups.
  const hulls = hullsFromPositions(seed.positions, nodes);
  const groupIds = new Map();
  for (const h of hulls) groupIds.set(h.key, [...h.members, ...nodes.filter((n) => n.kind === 'folder' && n.folder && _internals.folderKey(n.folder) === h.key).map((n) => n.id)]);
  separateGroups({
    positions: seed.positions, hulls, groupIds, nodeSizes: null,
    pinnedGroups: new Set(), passes: 40,
  });
  // Every hull pair must now be at >= GROUP_MIN_GAP - tolerance gap.
  // The sub-pixel tolerance absorbs the simulation's convergence drift.
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const g = rectGap(hulls[i], hulls[j]);
      assert.ok(g + 0.5 >= 24, `hulls ${hulls[i].key} vs ${hulls[j].key} gap ${g.toFixed(2)} < 24`);
    }
  }
});

test('separateGroups: a pinned hull is never moved by the pass', () => {
  // 2-folder graph. Pin the first hull. Drag the second hull to overlap
  // the first. The pass must move the second (unpinned) hull, not the first.
  const nodes = [
    { id: 'folder:f0', kind: 'folder', folder: 'C:/r/f0', parent: null },
    { id: 'a0', kind: 'agent', folder: 'C:/r/f0', parent: 'folder:f0' },
    { id: 'a1', kind: 'agent', folder: 'C:/r/f0', parent: 'folder:f0' },
    { id: 'folder:f1', kind: 'folder', folder: 'C:/r/f1', parent: null },
    { id: 'b0', kind: 'agent', folder: 'C:/r/f1', parent: 'folder:f1' },
    { id: 'b1', kind: 'agent', folder: 'C:/r/f1', parent: 'folder:f1' },
  ];
  const edges = [
    { id: 'e1', from: 'folder:f0', to: 'a0', kind: 'tree' },
    { id: 'e2', from: 'folder:f0', to: 'a1', kind: 'tree' },
    { id: 'e3', from: 'folder:f1', to: 'b0', kind: 'tree' },
    { id: 'e4', from: 'folder:f1', to: 'b1', kind: 'tree' },
  ];
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Snapshot the f0 positions so we can check they survive.
  const f0snap = new Map();
  for (const id of ['folder:f0', 'a0', 'a1']) f0snap.set(id, { ...seed.positions.get(id) });
  // Move every f1 member + f1 hub to overlap f0.
  const p0 = seed.positions.get('folder:f0');
  const f1ids = ['folder:f1', 'b0', 'b1'];
  for (const id of f1ids) {
    const p = seed.positions.get(id);
    p.x = p0.x + 5;
    p.y = p0.y + 3;
  }
  const hulls = hullsFromPositions(seed.positions, nodes);
  const groupIds = new Map();
  for (const h of hulls) groupIds.set(h.key, [...h.members, ...nodes.filter((n) => n.kind === 'folder' && n.folder && _internals.folderKey(n.folder) === h.key).map((n) => n.id)]);
  separateGroups({
    positions: seed.positions, hulls, groupIds, nodeSizes: null,
    pinnedGroups: new Set(['c:/r/f0']),
    passes: 40,
  });
  // f0 hub + members must be bit-for-bit where the snapshot put them.
  for (const [id, p] of f0snap) {
    const now = seed.positions.get(id);
    assert.ok(Math.abs(now.x - p.x) < 1e-9, `${id}.x moved: ${now.x} vs ${p.x}`);
    assert.ok(Math.abs(now.y - p.y) < 1e-9, `${id}.y moved: ${now.y} vs ${p.y}`);
  }
  // The two hulls must no longer overlap.
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const g = rectGap(hulls[i], hulls[j]);
      assert.ok(g + 0.5 >= 24, `hulls ${hulls[i].key} vs ${hulls[j].key} gap ${g.toFixed(2)} < 24`);
    }
  }
});

test('separateCardsGlobal: a global card sweep clears cross-folder overlap', () => {
  // 2-folder graph. Drop a f1 member on top of a f0 member (manual drag).
  // The sweep must push the f1 member away without moving the f0 member.
  const nodes = [
    { id: 'folder:f0', kind: 'folder', folder: 'C:/r/f0', parent: null },
    { id: 'a0', kind: 'agent', folder: 'C:/r/f0', parent: 'folder:f0' },
    { id: 'folder:f1', kind: 'folder', folder: 'C:/r/f1', parent: null },
    { id: 'b0', kind: 'agent', folder: 'C:/r/f1', parent: 'folder:f1' },
  ];
  const edges = [
    { id: 'e1', from: 'folder:f0', to: 'a0', kind: 'tree' },
    { id: 'e2', from: 'folder:f1', to: 'b0', kind: 'tree' },
  ];
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Park b0 on top of a0.
  const a0 = seed.positions.get('a0');
  seed.positions.set('b0', { x: a0.x + 3, y: a0.y + 2 });
  // Pin a0 (the "user dragged a0" scenario).
  separateCardsGlobal({
    nodes, positions: seed.positions, nodeSizes: null,
    pinnedIds: new Set(['a0']),
  });
  // a0 stays put.
  const a0after = seed.positions.get('a0');
  assert.equal(a0after.x, a0.x, 'a0.x preserved');
  assert.equal(a0after.y, a0.y, 'a0.y preserved');
  // a0 and b0 are no longer overlapping.
  const b0 = seed.positions.get('b0');
  const gapX = Math.abs(a0after.x - b0.x) - 220;
  const gapY = Math.abs(a0after.y - b0.y) - 56;
  assert.ok(gapX >= 12 || gapY >= 12,
    `a0=(${a0after.x.toFixed(1)},${a0after.y.toFixed(1)}) b0=(${b0.x.toFixed(1)},${b0.y.toFixed(1)}) gapX=${gapX.toFixed(1)} gapY=${gapY.toFixed(1)}`);
});

test('separateCardsGlobal: synthetic stream of newcomers never causes card overlap', () => {
  // The no-overlap guarantee under the per-poll workload: 5 newcomers in
  // 5 successive polls into a 2-folder graph. After every step, no card
  // overlaps another (the existing reconcilePositions test pins this for
  // a single poll; this one repeats to catch multi-poll regressions).
  const baseNodes = [
    { id: 'folder:f0', kind: 'folder', folder: 'C:/r/f0', parent: null },
    { id: 'a0', kind: 'agent', folder: 'C:/r/f0', parent: 'folder:f0' },
    { id: 'folder:f1', kind: 'folder', folder: 'C:/r/f1', parent: null },
    { id: 'b0', kind: 'agent', folder: 'C:/r/f1', parent: 'folder:f1' },
  ];
  const baseEdges = [
    { id: 'e1', from: 'folder:f0', to: 'a0', kind: 'tree' },
    { id: 'e2', from: 'folder:f1', to: 'b0', kind: 'tree' },
  ];
  const seed = computeLayout(baseNodes, baseEdges, { width: 1600, height: 1200, ticks: 200 });
  let positions = seed.positions;
  let nodes = baseNodes;
  for (let step = 0; step < 5; step++) {
    const id = `n${step}`;
    nodes = [...nodes, { id, kind: 'agent', folder: 'C:/r/f0', parent: 'folder:f0' }];
    // Re-derive the hulls from positions and call separateGroups + separateCardsGlobal.
    const grouped = new Map();
    for (const n of nodes) {
      if (n.kind === 'folder' || !n.folder) continue;
      const k = _internals.folderKey(n.folder);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(n);
    }
    // Place the newcomer near the folder hub with a tiny jitter.
    const fp = positions.get('folder:f0');
    positions.set(id, { x: fp.x + 5 + step * 30, y: fp.y + 10 + (step % 2) * 30 });
    // Run the global sweep; it must clear any overlap.
    separateCardsGlobal({ nodes, positions, nodeSizes: null });
    // After: no card-vs-card overlap.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (a.kind === 'folder' || b.kind === 'folder') continue;
        const pa = positions.get(a.id), pb = positions.get(b.id);
        if (!pa || !pb) continue;
        const gapX = Math.abs(pa.x - pb.x) - 220;
        const gapY = Math.abs(pa.y - pb.y) - 56;
        assert.ok(gapX >= 12 || gapY >= 12,
          `step ${step}: ${a.id} vs ${b.id} gapX=${gapX.toFixed(1)} gapY=${gapY.toFixed(1)}`);
      }
    }
  }
});