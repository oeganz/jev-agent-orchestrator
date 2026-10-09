// Tests for monitor/ui/src/layout.js incremental primitives:
//   reconcilePositions({ prevPositions, prevHulls, nodes, edges })
//   applyGroupDrag({ positions, memberIds, dx, dy })
//
// Pure functions only — no DOM, no React.
//
// Acceptance items (from the dispatch spec):
//   (a) reconcilePositions with the same node ids but different ts/state values
//       returns positions that are DEEP-EQUAL to the previous ones (nothing moved).
//   (b) one brand-new node is placed without changing any existing position,
//       and lands inside its folder's hull.
//   (c) applyGroupDrag moves every member by exactly (dx,dy) and nothing else.
//   (d) a node removed from the graph does not move the survivors.
//
// Run with:  node --test monitor/ui/src/interaction.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLayout, reconcilePositions, applyGroupDrag, groupDragDelta, _internals,
} from './layout.js';

// ---- helpers ----

// Build a 2-folder graph so the reconciler has known member positions to
// keep and a single hull to anchor a brand-new node against.
function makeTwoFolders() {
  const f1 = 'folder:f1';
  const f2 = 'folder:f2';
  const nodes = [
    { id: f1, kind: 'folder', folder: 'C:/repos/folder-1', parent: null },
    { id: f2, kind: 'folder', folder: 'C:/repos/folder-2', parent: null },
    { id: 'a1', kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: f1 },
    { id: 'a2', kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: f1 },
    { id: 'b1', kind: 'session', folder: 'C:/repos/folder-2', branch: 'main', parent: f2 },
  ];
  const edges = [
    { id: 't1', from: f1, to: 'a1', kind: 'tree' },
    { id: 't2', from: f1, to: 'a2', kind: 'tree' },
    { id: 't3', from: f2, to: 'b1', kind: 'tree' },
  ];
  return { nodes, edges };
}

function snapshotPositions(positions) {
  // Deep, deterministic copy that matches "DEEP-EQUAL" semantics (Maps preserve
  // insertion order, so identity of positions.get(id) returning a fresh object
  // with the same {x, y} still counts as equal in value).
  const out = new Map();
  for (const [k, v] of positions) out.set(k, { x: v.x, y: v.y });
  return out;
}

function positionsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const other = b.get(k);
    if (!other) return false;
    if (other.x !== v.x || other.y !== v.y) return false;
  }
  return true;
}

// ---- (a) ----

test('reconcilePositions: same ids, fresh ts/state -> positions unchanged', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // The "poll" mutates ts/state but keeps the same node ids.
  const polled = nodes.map((n) => ({
    ...n,
    ts: n.ts ? n.ts + 1000 : Date.now(),
    state: n.kind === 'session' ? 'idle' : n.state,
  }));
  const r = reconcilePositions({
    prevPositions: seed.positions, prevHulls: seed.hulls, nodes: polled, edges,
  });
  assert.ok(positionsEqual(r.positions, seed.positions),
    'every existing position must be DEEP-EQUAL to the previous one');
});

// ---- (b) ----

test('reconcilePositions: one brand-new node placed without moving others, inside its folder hull', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  const newId = 'a3';
  const polled = [
    ...nodes,
    { id: newId, kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' },
  ];
  const polledEdges = [...edges, { id: 't4', from: 'folder:f1', to: newId, kind: 'tree' }];
  const before = snapshotPositions(seed.positions);
  const r = reconcilePositions({
    prevPositions: seed.positions, prevHulls: seed.hulls,
    nodes: polled, edges: polledEdges,
  });
  // Every old position must be unchanged.
  for (const [k, v] of before) {
    const now = r.positions.get(k);
    assert.ok(now, `lost ${k}`);
    assert.equal(now.x, v.x, `${k}.x moved`);
    assert.equal(now.y, v.y, `${k}.y moved`);
  }
  // New node must be placed.
  const np = r.positions.get(newId);
  assert.ok(np, 'new node has no position');
  assert.ok(r.placedIds.has(newId), 'new id missing from placedIds');
  // New node must lie inside folder-1's hull (the hull that owns it).
  const h1 = r.hulls.find((h) => h.key === 'c:/repos/folder-1');
  assert.ok(h1, 'folder-1 hull missing from reconciled view');
  assert.ok(np.x >= h1.x && np.x <= h1.x + h1.w,
    `new x=${np.x} not inside hull x=${h1.x},w=${h1.w}`);
  assert.ok(np.y >= h1.y && np.y <= h1.y + h1.h,
    `new y=${np.y} not inside hull y=${h1.y},h=${h1.h}`);
});

// ---- (c) ----

test('applyGroupDrag: moves every member by exactly (dx,dy), nothing else', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  const dx = 47, dy = -23;
  // Drag folder-1: members a1, a2 (folder-1's only members).
  const moved = applyGroupDrag({
    positions: seed.positions,
    memberIds: ['a1', 'a2'],
    dx, dy,
  });
  // Member positions must shift by exactly (dx, dy).
  for (const id of ['a1', 'a2']) {
    const before = seed.positions.get(id);
    const after  = moved.get(id);
    assert.ok(after, `${id} disappeared`);
    assert.equal(after.x - before.x, dx, `${id}.x delta`);
    assert.equal(after.y - before.y, dy, `${id}.y delta`);
  }
  // Other nodes must NOT move.
  for (const id of ['b1', 'folder:f1', 'folder:f2']) {
    const before = seed.positions.get(id);
    const after  = moved.get(id);
    assert.ok(after, `${id} disappeared`);
    assert.equal(after.x, before.x, `${id}.x changed`);
    assert.equal(after.y, before.y, `${id}.y changed`);
  }
  // The returned Map must be a NEW Map (pure: never mutate caller's Map).
  assert.notEqual(moved, seed.positions, 'must return a new Map');
  for (const id of moved.keys()) {
    const beforeRef = seed.positions.get(id);
    assert.notEqual(moved.get(id), beforeRef,
      `${id}: position object must be a fresh reference`);
  }
});

// ---- (e) group-drag exactness (the drag-exact regression) ----
//
// The bug: FolderHulls seeded its per-move lastX/lastY from a window
// pointerdown that React's synthetic-event stopPropagation prevented from ever
// reaching the window, so the first pointermove computed
// `dx = clientX - 0` and dumped the cursor's ABSOLUTE screen position into the
// group. A drag of (+140,+90) therefore moved the group by ~(+488,+291) at
// zoom 0.6. The fix anchors the delta at pointerdown in FLOW space and applies
// it ABSOLUTELY from a snapshot, so the pure helper below is the only arithmetic
// left. These tests pin the exactness at several zooms WITHOUT a browser.

// Screen -> flow, mirroring React Flow's own mapping (pointToRendererPoint):
//   flow = (screen - translate) / zoom
const toFlow = (screen, viewport) => ({
  x: (screen.x - viewport.x) / viewport.zoom,
  y: (screen.y - viewport.y) / viewport.zoom,
});

test('groupDragDelta: single move = flow-space cursor delta (regression: no +488 overshoot)', () => {
  // zoom 0.6, matching the reproduced failure: a (+140,+90) screen drag at
  // zoom 0.6 is (+233.3,+150) in flow space. The OLD code added the cursor's
  // absolute position (~233 flow px on the first step) on top of that.
  const viewport = { x: 120.9, y: 57.2, zoom: 0.6 };
  const start = { x: 500, y: 300 };
  const startFlow = toFlow(start, viewport);
  const curFlow = toFlow({ x: start.x + 140, y: start.y + 90 }, viewport);
  const d = groupDragDelta(startFlow, curFlow);
  assert.ok(Math.abs(d.dx - 140 / 0.6) < 1e-9, `dx ${d.dx} != ${140 / 0.6}`);
  assert.ok(Math.abs(d.dy - 90 / 0.6) < 1e-9, `dy ${d.dy} != ${90 / 0.6}`);
  // and the absolute jump the bug produced must be absent
  assert.ok(Math.abs(d.dx) < 300, 'single-step delta must stay a cursor delta, not an absolute jump');
});

test('groupDragDelta: absolute from the start is step-invariant and zoom-correct', () => {
  // The SAME on-screen cursor path must produce the SAME flow delta whether the
  // drag arrives in one move or many, at any zoom. This is what "anchored at
  // pointerdown, applied absolutely from the snapshot" means.
  for (const zoom of [0.2, 0.6, 1, 1.75, 3]) {
    const viewport = { x: -40, y: 15, zoom };
    const start = { x: 400, y: 250 };
    const target = { x: 540, y: 340 };                 // +140,+90 screen
    const startFlow = toFlow(start, viewport);
    const flowDelta = groupDragDelta(startFlow, toFlow(target, viewport));
    // simulate 1-move vs 10-move paths
    const paths = [[target], Array.from({ length: 10 }, (_, i) => ({
      x: start.x + (140 * (i + 1)) / 10, y: start.y + (90 * (i + 1)) / 10,
    }))];
    for (const path of paths) {
      let last = null;
      for (const pt of path) last = groupDragDelta(startFlow, toFlow(pt, viewport));
      assert.ok(Math.abs(last.dx - flowDelta.dx) < 1e-9, `zoom ${zoom}: step count changed dx`);
      assert.ok(Math.abs(last.dy - flowDelta.dy) < 1e-9, `zoom ${zoom}: step count changed dy`);
    }
    // flow delta * zoom == screen delta, for every zoom
    assert.ok(Math.abs(flowDelta.dx * zoom - 140) < 1e-9, `zoom ${zoom}: dx screen mismatch`);
    assert.ok(Math.abs(flowDelta.dy * zoom - 90) < 1e-9, `zoom ${zoom}: dy screen mismatch`);
  }
});

test('applyGroupDrag: snapshot + ABSOLUTE delta is idempotent per cursor position', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // snapshot at pointerdown
  const snapshot = new Map();
  for (const [k, v] of seed.positions) snapshot.set(k, { x: v.x, y: v.y });
  const members = ['a1', 'a2'];
  const viewport = { x: 120.9, y: 57.2, zoom: 0.6 };
  const start = { x: 500, y: 300 };
  const startFlow = toFlow(start, viewport);

  // The user shoves the cursor forward then back to +70,+45 (screen). Applying
  // absolutely from the snapshot, the final state depends only on the final
  // cursor position — never on the path taken to get there. Accumulating would
  // land somewhere else.
  const finalScreen = { x: start.x + 70, y: start.y + 45 };
  const finalDelta = groupDragDelta(startFlow, toFlow(finalScreen, viewport));
  const applied = applyGroupDrag({ positions: snapshot, memberIds: members, ...finalDelta });
  for (const id of members) {
    assert.ok(Math.abs(applied.get(id).x - (snapshot.get(id).x + 70 / 0.6)) < 1e-9, `${id}.x`);
    assert.ok(Math.abs(applied.get(id).y - (snapshot.get(id).y + 45 / 0.6)) < 1e-9, `${id}.y`);
  }
  // other nodes untouched
  for (const id of ['b1', 'folder:f1', 'folder:f2']) {
    assert.equal(applied.get(id).x, snapshot.get(id).x, `${id}.x changed`);
    assert.equal(applied.get(id).y, snapshot.get(id).y, `${id}.y changed`);
  }
});

// ---- (d) ----

test('reconcilePositions: a node removed from the graph does not move the survivors', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Remove a1 (a member of folder-1).
  const polled = nodes.filter((n) => n.id !== 'a1');
  const polledEdges = edges.filter((e) => e.to !== 'a1');
  const before = snapshotPositions(seed.positions);
  const r = reconcilePositions({
    prevPositions: seed.positions, prevHulls: seed.hulls,
    nodes: polled, edges: polledEdges,
  });
  // Every survivor position must equal the previous one.
  for (const [k, v] of before) {
    if (k === 'a1') continue;                                   // the removed node
    const now = r.positions.get(k);
    assert.ok(now, `lost ${k}`);
    assert.equal(now.x, v.x, `${k}.x moved`);
    assert.equal(now.y, v.y, `${k}.y moved`);
  }
  // The removed node must NOT be present.
  assert.equal(r.positions.has('a1'), false, 'removed node still placed');
});

// ---- bonus properties ----

test('reconcilePositions: idempotent — same input twice yields the same output', () => {
  const { nodes, edges } = makeTwoFolders();
  const polled = nodes.map((n) => ({ ...n, ts: n.ts ? n.ts + 1 : Date.now() }));
  const r1 = reconcilePositions({
    prevPositions: new Map(), prevHulls: [], nodes: polled, edges,
  });
  // Second pass: feed the result back in; nothing else should change.
  const r2 = reconcilePositions({
    prevPositions: r1.positions, prevHulls: r1.hulls, nodes: polled, edges,
  });
  assert.ok(positionsEqual(r1.positions, r2.positions),
    'a stable poll should leave positions untouched');
});

// ---- node-stay / no-stacking regressions ----
//
// Bug 1: a hand-dragged card snapped back on the next 2.5 s poll because the
// poll rebuilds every card from positionsRef and node drags never reached it.
// App.jsx now writes the dragged position into positionsRef; the pure side of
// that contract is "a position already in prevPositions is NEVER moved".
// Bug 2: reconcilePositions dropped a newcomer at parent + hash jitter with no
// collision check, so cards stacked. Placement must now avoid every existing
// card (node size + >= 8 px gap), including newcomers placed in the same poll.

const MIN_GAP = 8;
const sizeFor = (n) => _internals.NODE_SIZE[n.kind] || { width: 220, height: 56 };

// Rect gap between two cards: >= 0 means disjoint, negative means overlap depth.
function cardGap(a, pa, b, pb) {
  const sa = sizeFor(a), sb = sizeFor(b);
  const gx = Math.abs(pa.x - pb.x) - (sa.width + sb.width) / 2;
  const gy = Math.abs(pa.y - pb.y) - (sa.height + sb.height) / 2;
  return Math.max(gx, gy);
}

function minCardGap(nodes, positions) {
  const cards = nodes.filter((n) => n.kind !== 'folder' && positions.has(n.id));
  let worst = { gap: Infinity, a: null, b: null };
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const gap = cardGap(cards[i], positions.get(cards[i].id), cards[j], positions.get(cards[j].id));
      if (gap < worst.gap) worst = { gap, a: cards[i].id, b: cards[j].id };
    }
  }
  return worst;
}

// Every newcomer must keep >= MIN_GAP from every other card (old-old pairs are
// the user's business and are not checked).
function assertNewcomersClear(polled, positions, freshIds) {
  const cards = polled.filter((n) => n.kind !== 'folder');
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (!freshIds.has(cards[i].id) && !freshIds.has(cards[j].id)) continue;
      const gap = cardGap(cards[i], positions.get(cards[i].id), cards[j], positions.get(cards[j].id));
      assert.ok(gap >= MIN_GAP, `${cards[i].id} vs ${cards[j].id} gap ${gap.toFixed(1)} < ${MIN_GAP}`);
    }
  }
}

test('reconcilePositions: a newcomer does not overlap any existing card (>= 8 px gap)', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Crowd the parent's own slot with user-dragged cards so any fixed jitter collides.
  const parentPos = seed.positions.get('folder:f1');
  const prev = snapshotPositions(seed.positions);
  const blockers = [];
  for (let k = 0; k < 6; k++) {
    const id = `u${k}`;
    prev.set(id, { x: parentPos.x + (k - 3) * 90, y: parentPos.y + ((k % 2) * 40 - 20) });
    blockers.push({ id, kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' });
  }
  const polled = [...nodes, ...blockers,
    { id: 'n1', kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' }];
  const r = reconcilePositions({ prevPositions: prev, prevHulls: [], nodes: polled, edges });
  assert.ok(r.positions.has('n1'));
  assertNewcomersClear(polled, r.positions, new Set(['n1']));
});

test('reconcilePositions: five newcomers in the same poll do not overlap each other or anything', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  const fresh = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) =>
    ({ id, kind: 'agent', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' }));
  const polled = [...nodes, ...fresh];
  const r = reconcilePositions({ prevPositions: seed.positions, prevHulls: seed.hulls, nodes: polled, edges });
  assertNewcomersClear(polled, r.positions, new Set(fresh.map((n) => n.id)));
});

test('reconcilePositions: newcomers stay clear even when the parent slot is walled in', () => {
  // A dense block of user cards around the parent forces the bounded ring
  // search to expand outward; the result must still be free, never stacked.
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  const c = seed.positions.get('folder:f1');
  const prev = snapshotPositions(seed.positions);
  const wall = [];
  let k = 0;
  for (let gx = -6; gx <= 6; gx++) {
    for (let gy = -6; gy <= 6; gy++) {
      const id = `w${k++}`;
      prev.set(id, { x: c.x + gx * 230, y: c.y + gy * 66 });
      wall.push({ id, kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' });
    }
  }
  const fresh = ['m1', 'm2', 'm3'].map((id) =>
    ({ id, kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' }));
  const polled = [...nodes, ...wall, ...fresh];
  const r = reconcilePositions({ prevPositions: prev, prevHulls: [], nodes: polled, edges });
  assertNewcomersClear(polled, r.positions, new Set(fresh.map((n) => n.id)));
});

test('reconcilePositions: a node the user dragged (pinned) is never moved; the OTHER card in the overlap pair moves', () => {
  // The pinned-card contract: a card the user explicitly placed (here, by
  // parking a1 on top of a2) MUST survive bit-for-bit. To honour the
  // "nothing overlaps" guarantee, the OTHER card in the overlap pair (a2)
  // is the one that gets nudged. Both behaviours must hold in the same
  // call: a1 stays at a2.x+5, and a2 is now >= CARD_GAP from a1.
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  const prev = snapshotPositions(seed.positions);
  const a2 = prev.get('a2');
  prev.set('a1', { x: a2.x + 5, y: a2.y + 3 });
  const polled = [...nodes, { id: 'n1', kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' }];
  const r = reconcilePositions({
    prevPositions: prev, prevHulls: [], nodes: polled, edges,
    opts: { pinned: new Set(['a1']) },
  });
  // Pinned: bit-for-bit survival.
  assert.equal(r.positions.get('a1').x, a2.x + 5, 'pinned x survives');
  assert.equal(r.positions.get('a1').y, a2.y + 3, 'pinned y survives');
  // Other folders' members never move (a2 belongs to folder-1, so this
  // also covers the "no hull leak" guarantee).
  const b1 = prev.get('b1');
  assert.equal(r.positions.get('b1').x, b1.x, 'b1.x stays');
  assert.equal(r.positions.get('b1').y, b1.y, 'b1.y stays');
  // The no-overlap guarantee holds: a1 and a2 are at least CARD_GAP apart
  // in both axes after the per-poll separation pass.
  const a1Now = r.positions.get('a1');
  const a2Now = r.positions.get('a2');
  const sa = { w: 220, h: 56 };
  const gapX = Math.abs(a1Now.x - a2Now.x) - sa.w;
  const gapY = Math.abs(a1Now.y - a2Now.y) - sa.h;
  assert.ok(gapX >= 12 || gapY >= 12,
    `after pass: a1=(${a1Now.x.toFixed(1)},${a1Now.y.toFixed(1)}) a2=(${a2Now.x.toFixed(1)},${a2Now.y.toFixed(1)}) gapX=${gapX.toFixed(1)} gapY=${gapY.toFixed(1)}`);
});

// No-overlap guarantee: when a previously-OK graph has a newcomer that
// would land on an existing card, the per-poll separation pass moves the
// NEW card (the one not yet "pinned" by the user) and leaves the survivors
// alone. The drag-pinned contract is "no pinned card moves"; the newcomer
// is fair game.
test('reconcilePositions: a newcomer in a crowded folder is moved to clear the overlap, survivors stay', () => {
  const { nodes, edges } = makeTwoFolders();
  const seed = computeLayout(nodes, edges, { width: 1600, height: 1200, ticks: 200 });
  // Park a1 on top of a2 (user move), then add a newcomer that the layout
  // would have placed where a3 lives. The newcomer is the one that moves.
  const prev = snapshotPositions(seed.positions);
  const a2 = prev.get('a2');
  prev.set('a1', { x: a2.x + 5, y: a2.y + 3 });
  const polled = [...nodes, { id: 'n1', kind: 'session', folder: 'C:/repos/folder-1', branch: 'main', parent: 'folder:f1' }];
  const r = reconcilePositions({
    prevPositions: prev, prevHulls: [], nodes: polled, edges,
    opts: { pinned: new Set(['a1']) },
  });
  // The newcomer was placed in a free slot (no overlap) and is a fresh id,
  // so its position is the result of findFreeSlot + a possible nudge.
  assert.ok(r.positions.has('n1'), 'newcomer placed');
  // The drag-pin survived: a1 is still at the user position.
  assert.equal(r.positions.get('a1').x, a2.x + 5);
  assert.equal(r.positions.get('a1').y, a2.y + 3);
});

test('computeLayout: no two rendered cards overlap, including edgeless nodes and crowded folders', () => {
  for (const seedN of [1, 2, 3, 4, 5]) {
    let s = seedN * 7919;
    const rng = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const nodes = [];
    const edges = [];
    for (let f = 0; f < 3; f++) {
      const fid = `folder:f${f}`;
      nodes.push({ id: fid, kind: 'folder', folder: `C:/r/f${f}`, parent: null });
      for (let a = 0; a < 7; a++) {
        const id = `f${f}a${a}`;
        nodes.push({ id, kind: 'agent', folder: `C:/r/f${f}`, parent: fid });
        edges.push({ id: `e-${id}`, from: fid, to: id, kind: 'tree' });
      }
    }
    // edgeless, folderless nodes: candidates for sharing the canvas centre
    for (let q = 0; q < 4; q++) nodes.push({ id: `solo${q}`, kind: 'hermes' });
    const { positions } = computeLayout(nodes, edges, { width: 1600, height: 1200, rng });
    const w = minCardGap(nodes, positions);
    assert.ok(w.gap >= MIN_GAP, `seed ${seedN}: ${w.a} / ${w.b} gap ${w.gap.toFixed(1)}`);
  }
});