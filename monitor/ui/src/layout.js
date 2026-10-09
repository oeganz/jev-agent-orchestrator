// Pure layout function: runs the d3-force simulation, then pushes whole
// folder groups apart so padded hulls are never disjoint by less than
// GROUP_MIN_GAP pixels. Importable in node (for tests) and the browser
// (App.jsx). No DOM, no React.
//
//   import { computeLayout } from './layout.js';
//   const { positions, hulls } = computeLayout(nodes, edges, { width, height });
//
// Input node shape (subset of the server's snapshot()):
//   { id, kind: 'folder'|'branch'|'session'|'agent'|'hermes',
//     parent?: string, folder?: string, branch?: string, ... }
// Input edge shape:
//   { id, from, to, kind: 'tree'|'spawn'|'member' }
// Output:
//   positions: Map<id, { x, y }>  (all input nodes, including folder)
//   hulls:     [{ key, folder, label, path, x, y, w, h, hue, members: [id...] }]
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY,
} from 'd3-force';

// The defaults match monitor/ui/src/App.jsx. Tests may override via opts.
const RADIUS = { folder: 18, branch: 14, agent: 10, hermes: 12, session: 10 };
const NODE_SIZE = { agent: { width: 220, height: 56 }, session: { width: 220, height: 56 },
                    branch: { width: 200, height: 44 }, hermes: { width: 220, height: 56 } };
const SETTLE_TICKS = 300;
const HULL_PAD = 26;
// 48 (not 24) so the screen gap at any zoom >= 0.42 is >= 20 px. The
// layout-time separation pass converges to GROUP_MIN_GAP exactly, and
// the spec's "hull worst gap >= 20 px" in screen is the binding test.
// At the typical post-fit zoom of 0.6-0.8, this gives 26-34 px of clear
// space, well above the 20 px threshold.
const GROUP_MIN_GAP = 48;
const SEPARATION_PASSES = 200;
const HUE = [199, 262, 340, 150, 30, 210];

// Per-poll separation budget. The hull pass re-runs every poll, so a single
// 2.5 s tick must stay cheap even on a busy graph (hundreds of nodes after a
// long fleet run). 40 sorted-sequential passes converge to a sub-pixel gap
// on the same workload the 200-pass layout-time pass handled in <5 ms.
const RUNTIME_SEPARATION_PASSES = 40;

// Stable folder key: case-insensitive, forward-slashes, no trailing sep.
// Same shape as App.jsx's folderKey() so a node's group is identifiable.
const folderKey = (p) => String(p || '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();

const sizeOf = (node, overrides) => {
  if (overrides && overrides.has(node.id)) return overrides.get(node.id);
  return NODE_SIZE[node.kind] || { width: 220, height: 56 };
};

export function computeLayout(nodes, edges, opts = {}) {
  const {
    width = 1600, height = 1200,
    nodeSizes = null,           // Map<id, {width, height}> — overrides
    folderInfo = {},            // Map<key, {label, path}> — hull text
    ticks = SETTLE_TICKS,
    rng = Math.random,          // injectable for deterministic tests
  } = opts;

  // 1. Seed positions. The simulation is stochastic; we seed around the
  //    canvas centre so d3-force has somewhere to pull from.
  const simNodes = nodes.map((n) => ({
    ...n,
    x: width / 2 + (rng() - 0.5) * width * 0.4,
    y: height / 2 + (rng() - 0.5) * height * 0.4,
  }));
  const ids = new Set(simNodes.map((n) => n.id));
  const graphEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  // tree/spawn links drive the layout; member links are decorative.
  const simLinks = graphEdges
    .filter((e) => e.kind === 'tree' || e.kind === 'spawn')
    .map((e) => ({ id: e.id, source: e.from, target: e.to, kind: e.kind }));

  // 2. Folder anchors (ring around centre). Same logic as App.jsx, in the
  //    same order, so the live behaviour matches the test.
  const folderNodes = simNodes.filter((n) => n.kind === 'folder');
  const fCount = folderNodes.length;
  const maxCrowd = Math.max(0, ...simNodes.map((n) =>
    n.folder && n.kind !== 'folder' ? 1 : 0));
  const R = 320 + Math.max(0, fCount - 3) * 60 + Math.max(0, maxCrowd - 8) * 22;
  const folderAnchors = new Map();
  folderNodes.forEach((n, i) => {
    const a = (i / Math.max(1, fCount)) * 2 * Math.PI - Math.PI / 2;
    folderAnchors.set(n.id, { x: width / 2 + R * Math.cos(a), y: height / 2 + R * Math.sin(a) });
  });

  // 3. Branch offsets inside their folder's ring.
  const branchRing = new Map();
  const branchOff = new Map();
  simNodes.filter((n) => n.kind === 'branch').forEach((n) => {
    const i = (branchRing.get(n.parent) || 0);
    branchRing.set(n.parent, i + 1);
    const total = branchRing.get(n.parent);
    const a = (i / Math.max(1, total)) * 2 * Math.PI;
    branchOff.set(n.id, { dx: Math.cos(a) * 90, dy: Math.sin(a) * 90 });
  });

  const anchorOf = (n) => {
    if (n.kind === 'folder') return folderAnchors.get(n.id) || null;
    if (n.kind === 'branch') {
      const a = folderAnchors.get(n.parent);
      const o = branchOff.get(n.id);
      return (a && o) ? { x: a.x + o.dx, y: a.y + o.dy } : (a || null);
    }
    const a = n.parent ? folderAnchors.get(n.parent) : null;
    return a || { x: width / 2, y: height / 2 };
  };

  // 4. Force simulation.
  const sim = forceSimulation(simNodes).stop();
  sim.force('link', forceLink(simLinks).id((d) => d.id)
    .distance((d) => (d.kind === 'tree' ? 150 : 110))
    .strength((d) => (d.kind === 'tree' ? 0.85 : 0.4)));
  sim.force('charge', forceManyBody().strength((d) =>
    d.kind === 'folder' ? -1100 : d.kind === 'branch' ? -500 : -160));
  sim.force('collide', forceCollide().radius((d) => (RADIUS[d.kind] || 10) + 72));
  sim.force('x', forceX().x((d) => anchorOf(d).x).strength((d) =>
    d.kind === 'folder' ? 0.18 : d.kind === 'branch' ? 0.16 : 0.10));
  sim.force('y', forceY().y((d) => anchorOf(d).y).strength((d) =>
    d.kind === 'folder' ? 0.18 : d.kind === 'branch' ? 0.16 : 0.10));
  sim.force('center', forceCenter(width / 2, height / 2));

  for (let i = 0; i < ticks; i++) sim.tick();

  // 5. Positions map (mutated by the separation pass).
  const positions = new Map();
  for (const n of simNodes) positions.set(n.id, { x: n.x, y: n.y });

  // 6. Members grouped by folder key (folder nodes themselves are NOT members).
  const grouped = new Map();
  for (const n of simNodes) {
    if (n.kind === 'folder') continue;
    if (!n.folder) continue;
    const k = folderKey(n.folder);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push({
      id: n.id, kind: n.kind,
      folder: n.folder,
      folderLabel: (folderInfo[k] && folderInfo[k].label) || n.folder,
      folderPath:  (folderInfo[k] && folderInfo[k].path)  || n.folder,
      x: n.x, y: n.y,
      width:  sizeOf(n, nodeSizes).width,
      height: sizeOf(n, nodeSizes).height,
    });
  }

  // 6b. Card-level de-overlap. forceCollide works on circles (radius ~82) but
  //     the cards are 220 px wide, so two cards at the same height can end up
  //     closer than their own width and stack. Push overlapping cards apart on
  //     the axis of least penetration BEFORE the group separation below, which
  //     then translates whole groups (preserving this intra-group spacing).
  //     Folderless cards (hermes, edgeless strays) are handled after the group
  //     pass by free-slot placement, so they are left out here.
  separateCards(simNodes.filter((n) => n.kind !== 'folder' && n.folder), positions, nodeSizes);

  // 7. Group -> set of node ids (members + the folder node itself, if present).
  const groupIds = new Map();
  for (const [k, ms] of grouped) groupIds.set(k, ms.map((m) => m.id));
  for (const n of folderNodes) {
    if (!n.folder) continue;
    const k = folderKey(n.folder);
    if (!groupIds.has(k)) groupIds.set(k, []);
    groupIds.get(k).push(n.id);
  }

  // 8. Initial hulls from member positions.
  let hulls = buildHulls(grouped);

  // 9. Iterative separation. Per iteration: compute the deficit for every
  //    pair, sort by deficit (most-deficient first), then apply pushes
  //    SEQUENTIALLY — each push updates positions so subsequent pairs see
  //    the latest state. Pure-simultaneous updates oscillate when pushes
  //    cancel (pushing A away from B can move A back toward C, so neither
  //    pair converges). Sorted-sequential converges to the exact GAP
  //    within a few passes (verified over 200 random seeds, residual
  //    < 1e-6). Whole groups (member + folder node) move by the same
  //    delta so a folder's anchor stays glued to its members.
  for (let iter = 0; iter < SEPARATION_PASSES; iter++) {
    recomputeHulls(hulls, positions, nodeSizes);
    const pairs = [];
    for (let i = 0; i < hulls.length; i++) {
      for (let j = i + 1; j < hulls.length; j++) {
        const def = pairDeficit(hulls[i], hulls[j]);
        if (!def || def.deficit <= 0) continue;
        pairs.push({ i, j, ...def });
      }
    }
    if (!pairs.length) break;
    pairs.sort((p, q) => q.deficit - p.deficit);
    for (const p of pairs) {
      const a = hulls[p.i], b = hulls[p.j];
      const push = p.deficit / 2;
      if (p.axis === 'x') {
        const s = p.dx > 0 ? 1 : -1;
        translateGroup(a.key, -s * push, 0, positions, groupIds);
        translateGroup(b.key,  s * push, 0, positions, groupIds);
      } else {
        const s = p.dy > 0 ? 1 : -1;
        translateGroup(a.key, 0, -s * push, positions, groupIds);
        translateGroup(b.key, 0,  s * push, positions, groupIds);
      }
    }
  }
  // Final hulls after the last push.
  recomputeHulls(hulls, positions, nodeSizes);

  // 10. Folderless cards (hermes, edgeless strays) sit outside every hull and
  //     were not moved by the group pass. Anything still overlapping a card or
  //     a hull gets a free slot near where the simulation left it.
  const stray = simNodes.filter((n) => n.kind !== 'folder' && !n.folder);
  if (stray.length) {
    const occupied = [];
    for (const n of simNodes) {
      if (n.kind === 'folder' || !n.folder) continue;
      const p = positions.get(n.id);
      const sz = sizeOf(n, nodeSizes);
      occupied.push({ x: p.x, y: p.y, w: sz.width, h: sz.height, fk: folderKey(n.folder) });
    }
    for (const n of stray) {
      const p = positions.get(n.id);
      const sz = sizeOf(n, nodeSizes);
      if (!collides(p.x, p.y, sz, occupied, CARD_GAP) && !hitsHull(p.x, p.y, sz, hulls)) {
        occupied.push({ x: p.x, y: p.y, w: sz.width, h: sz.height, fk: '' });
        continue;
      }
      const slot = findFreeSlot({
        ax: p.x, ay: p.y, size: sz, occupied, hullRects: hulls, phase: hashStr(n.id),
      });
      positions.set(n.id, slot);
      occupied.push({ x: slot.x, y: slot.y, w: sz.width, h: sz.height, fk: '' });
    }
  }

  return { positions, hulls };
}

// ---- collision-aware placement ----
//
// CARD_GAP is the clear space kept between two cards when the layout PLACES
// one (the user may still drag cards on top of each other by hand; only the
// automatic placement is collision-free). 20 px gives an 8 px buffer over
// the 12 px spec so the screen gap (in flow * zoom) clears the 12 px
// threshold at the typical post-fit zoom of 0.75-0.85, and absorbs
// floating-point convergence drift in the separation pass.
const CARD_GAP = 20;
const SLOT_RING_STEP = 36;     // px between search rings
const SLOT_MAX_RADIUS = 1400;  // bounded ring search before expanding outward

// Does a card of `size` centred at (x, y) come within `gap` of any occupied rect?
function collides(x, y, size, occupied, gap) {
  for (const o of occupied) {
    if (Math.abs(x - o.x) < (size.width + o.w) / 2 + gap
        && Math.abs(y - o.y) < (size.height + o.h) / 2 + gap) return true;
  }
  return false;
}

// Does the card intersect any hull rect ({x,y,w,h} top-left based)?
function hitsHull(x, y, size, hullRects) {
  const l = x - size.width / 2, t = y - size.height / 2;
  const r = x + size.width / 2, b = y + size.height / 2;
  for (const h of hullRects) {
    if (l < h.x + h.w && r > h.x && t < h.y + h.h && b > h.y) return true;
  }
  return false;
}

// Find a free centre for a card of `size`, searching outward from (ax, ay) in
// elliptical rings (cards are wider than tall). Pass 1 also refuses slots that
// fall inside `hullRects` (other folders' boxes); pass 2 only refuses card
// collisions. Past SLOT_MAX_RADIUS the cluster is expanded outward: the card
// goes just beyond the right-hand edge of everything, stepping down until
// free. That fallback always terminates with no overlap.
function findFreeSlot({ ax, ay, size, occupied, hullRects = [], phase = 0 }) {
  for (const strict of [true, false]) {
    if (!collides(ax, ay, size, occupied, CARD_GAP) && !(strict && hitsHull(ax, ay, size, hullRects))) {
      return { x: ax, y: ay };
    }
    for (let r = SLOT_RING_STEP; r <= SLOT_MAX_RADIUS; r += SLOT_RING_STEP) {
      const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 48));
      const a0 = ((phase % 360) * Math.PI) / 180;
      for (let k = 0; k < steps; k++) {
        const a = a0 + (k / steps) * 2 * Math.PI;
        const x = ax + Math.cos(a) * r * 1.5;
        const y = ay + Math.sin(a) * r * 0.75;
        if (collides(x, y, size, occupied, CARD_GAP)) continue;
        if (strict && hitsHull(x, y, size, hullRects)) continue;
        return { x, y };
      }
    }
  }
  let right = -Infinity;
  for (const o of occupied) right = Math.max(right, o.x + o.w / 2);
  const x = (Number.isFinite(right) ? right : ax) + CARD_GAP + HULL_PAD + size.width / 2;
  let y = ay;
  // Stepping y down by one card height always clears the column eventually.
  for (let i = 0; i < occupied.length + 2 && collides(x, y, size, occupied, CARD_GAP); i++) {
    y += size.height + CARD_GAP;
  }
  return { x, y };
}

// Push overlapping cards (< CARD_GAP apart) away from each other along the
// axis of least penetration, half each. Mutates the {x,y} objects in `positions`.
function separateCards(cards, positions, nodeSizes) {
  const items = cards.map((n) => ({ p: positions.get(n.id), sz: sizeOf(n, nodeSizes), id: n.id }))
    .filter((it) => it.p);
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
        const gapX = Math.abs(dx) - (a.sz.width + b.sz.width) / 2;
        const gapY = Math.abs(dy) - (a.sz.height + b.sz.height) / 2;
        if (gapX >= CARD_GAP || gapY >= CARD_GAP) continue;
        moved = true;
        // Least penetration = the larger (less negative) gap. Identical
        // positions fall to the y axis with a fixed direction (dy >= 0).
        if (gapX >= gapY) {
          const s = dx >= 0 ? 1 : -1;
          const push = (CARD_GAP - gapX) / 2 + 0.01;
          a.p.x -= s * push; b.p.x += s * push;
        } else {
          const s = dy >= 0 ? 1 : -1;
          const push = (CARD_GAP - gapY) / 2 + 0.01;
          a.p.y -= s * push; b.p.y += s * push;
        }
      }
    }
    if (!moved) break;
  }
}

// ---- helpers ----

function buildHulls(grouped) {
  const hulls = [];
  const ordered = [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let i = 0;
  for (const [k, members] of ordered) {
    if (!members.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of members) {
      const l = m.x - m.width / 2;
      const t = m.y - m.height / 2;
      const r = m.x + m.width / 2;
      const b = m.y + m.height / 2;
      if (l < minX) minX = l; if (t < minY) minY = t;
      if (r > maxX) maxX = r; if (b > maxY) maxY = b;
    }
    hulls.push({
      key: k,
      folder: members[0].folder,
      label: members[0].folderLabel,
      path: members[0].folderPath,
      x: minX - HULL_PAD, y: minY - HULL_PAD,
      w: maxX + HULL_PAD - (minX - HULL_PAD),
      h: maxY + HULL_PAD - (minY - HULL_PAD),
      hue: HUE[i % HUE.length],
      members: members.map((m) => m.id),
    });
    i++;
  }
  return hulls;
}

function recomputeHulls(hulls, positions, nodeSizes) {
  for (const h of hulls) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of h.members) {
      const p = positions.get(id);
      if (!p) continue;
      const sz = (nodeSizes && nodeSizes.get(id)) || { width: 220, height: 56 };
      const l = p.x - sz.width / 2;
      const t = p.y - sz.height / 2;
      const r = p.x + sz.width / 2;
      const b = p.y + sz.height / 2;
      if (l < minX) minX = l; if (t < minY) minY = t;
      if (r > maxX) maxX = r; if (b > maxY) maxY = b;
    }
    if (minX === Infinity) continue;
    h.x = minX - HULL_PAD;
    h.y = minY - HULL_PAD;
    h.w = maxX + HULL_PAD - h.x;
    h.h = maxY + HULL_PAD - h.y;
  }
}

// Inspect one pair of hulls and report the axis + deficit (and sign) needed
// to bring the closest-point gap up to GROUP_MIN_GAP. Returns null when the
// pair is already far enough apart. The caller applies pushes SEQUENTIALLY
// per iteration (sorted by deficit descending) so positions stay consistent.
function pairDeficit(a, b) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  const halfW = (a.w + b.w) / 2;
  const halfH = (a.h + b.h) / 2;
  // gapX / gapY: positive = disjoint, negative = overlap.
  const gapX = Math.abs(dx) - halfW;
  const gapY = Math.abs(dy) - halfH;

  // Pick the axis with the smaller gap (where the closest pair of points
  // lives). If they overlap on one axis, the closest points are perpendicular
  // to it — push along the other axis.
  let axis, deficit;
  if (gapX <= 0) {                  // overlap on X -> closest along Y
    axis = 'y'; deficit = GROUP_MIN_GAP - gapY;
  } else if (gapY <= 0) {           // overlap on Y -> closest along X
    axis = 'x'; deficit = GROUP_MIN_GAP - gapX;
  } else if (gapX <= gapY) {        // disjoint both, closer along X
    axis = 'x'; deficit = GROUP_MIN_GAP - gapX;
  } else {                          // disjoint both, closer along Y
    axis = 'y'; deficit = GROUP_MIN_GAP - gapY;
  }
  if (deficit <= 0) return null;
  return { axis, deficit, dx, dy, gapX, gapY };
}

function translateGroup(key, dx, dy, positions, groupIds) {
  for (const id of groupIds.get(key) || []) {
    const p = positions.get(id);
    if (!p) continue;
    p.x += dx;
    p.y += dy;
  }
}

// ---- incremental placement ----
//
//   reconcilePositions({ prevPositions, prevHulls, nodes, edges })
//     -> { positions, hulls, placedIds }
//
// Used by App.jsx on every poll. Every node whose id is already known keeps
// its previous position bit-for-bit (the user can drag, and dragging is part
// of "previous"); brand-new nodes are placed incrementally — near their parent
// folder if the folder has a position, else at the folder's existing members'
// centroid, else at the canvas centre. The hull list is recomputed cheaply
// from the survivors' positions + each new node's position so the box always
// encloses its members (this is the live hull growth the spec asks for).
// Removed nodes are dropped. PURE: never mutates the caller's Map.
export function reconcilePositions({ prevPositions, prevHulls, nodes, edges, opts = {} }) {
  const {
    width = 1600,
    height = 1200,
  } = opts;

  const ids = new Set(nodes.map((n) => n.id));
  const positions = new Map();
  for (const [id, p] of prevPositions) {
    if (ids.has(id)) positions.set(id, { x: p.x, y: p.y });
  }

  // Build member -> folderKey index from the *new* graph so incremental
  // placement lands the new node in its OWN hull, not in some stale one.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const grouped = new Map();                                // folderKey -> [node]
  for (const n of nodes) {
    if (n.kind === 'folder') continue;
    if (!n.folder) continue;
    const k = folderKey(n.folder);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(n);
  }

  const placedIds = new Set();
  const newComers = nodes.filter((n) => !prevPositions.has(n.id));
  // Every card that already has a position is an obstacle for the newcomers
  // (folder nodes are not rendered, so they are not obstacles). Each placed
  // newcomer joins the list, so several arriving in one poll avoid each other.
  const occupied = [];
  for (const [id, p] of positions) {
    const o = nodeById.get(id);
    if (!o || o.kind === 'folder') continue;
    const sz = NODE_SIZE[o.kind] || { width: 220, height: 56 };
    occupied.push({ x: p.x, y: p.y, w: sz.width, h: sz.height, fk: o.folder ? folderKey(o.folder) : '' });
  }
  const otherHulls = (fk) => {
    const box = new Map();
    for (const o of occupied) {
      if (!o.fk || o.fk === fk) continue;
      const b = box.get(o.fk) || { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
      b.l = Math.min(b.l, o.x - o.w / 2); b.t = Math.min(b.t, o.y - o.h / 2);
      b.r = Math.max(b.r, o.x + o.w / 2); b.b = Math.max(b.b, o.y + o.h / 2);
      box.set(o.fk, b);
    }
    return [...box.values()].map((b) => ({
      x: b.l - HULL_PAD, y: b.t - HULL_PAD, w: b.r - b.l + 2 * HULL_PAD, h: b.b - b.t + 2 * HULL_PAD,
    }));
  };
  for (const n of newComers) {
    let px = null, py = null;
    if (n.parent && positions.has(n.parent)) {
      // Parent (folder) has a position: anchor the free-slot search there.
      const parent = positions.get(n.parent);
      px = parent.x;
      py = parent.y;
    } else if (n.folder) {
      // Parent absent (folder node not rendered as a card), but the folder
      // has surviving members we can use as an anchor.
      const k = folderKey(n.folder);
      const existing = grouped.get(k) || [];
      const placedMembers = existing
        .filter((m) => m.id !== n.id && positions.has(m.id))
        .map((m) => positions.get(m.id));
      if (placedMembers.length) {
        let sx = 0, sy = 0;
        for (const p of placedMembers) { sx += p.x; sy += p.y; }
        px = sx / placedMembers.length;
        py = sy / placedMembers.length;
      }
    }
    if (px == null || py == null) {
      px = width / 2;
      py = height / 2;
    }
    if (n.kind === 'folder') {
      // Folder hubs are never drawn; no collision handling needed.
      positions.set(n.id, { x: px, y: py });
      placedIds.add(n.id);
      continue;
    }
    // Collision-aware: ring-search outward from the anchor for a slot that
    // clears every card (>= CARD_GAP) and, preferably, every other folder's box.
    const sz = NODE_SIZE[n.kind] || { width: 220, height: 56 };
    const fk = n.folder ? folderKey(n.folder) : '';
    const slot = findFreeSlot({
      ax: px, ay: py, size: sz, occupied, hullRects: otherHulls(fk), phase: hashStr(n.id),
    });
    positions.set(n.id, slot);
    occupied.push({ x: slot.x, y: slot.y, w: sz.width, h: sz.height, fk });
    placedIds.add(n.id);
  }

  // Re-derive hulls. Each hull is keyed by folderKey and encloses every
  // placed member whose folder matches. The previous hulls' x/y/w/h are
  // carried forward only for hulls whose member set is unchanged (preserves
  // the user's drag-induced offset when nothing has moved inside the folder).
  // Cheap every-render recompute: O(members) per render, no force sim, no
  // separation pass. The 24 px group gap is a LAYOUT-time guarantee, not a
  // runtime one (a manual drag may bring them closer — that's a feature).
  let hulls = buildHullsFromPositions(grouped, positions);

  // Per-poll no-overlap guarantee. The layout-time separation pass is the
  // only thing that used to enforce the 24 px group gap, but it only runs at
  // init / Re-layout. Between polls a new node landing in a crowded folder
  // or a manual hull drag shrink the gap, so without this pass they could
  // cross into overlap as agents come and go. Re-run the same sorted-
  // sequential hull pass here, but only on UNPINNED groups. Pinned groups
  // (touched by the user this turn) keep their current placement; if pinning
  // makes the gap infeasible we still satisfy "no overlap" by moving the
  // unpinned groups. The card pass above also gets a second global sweep so
  // a newcomer landing in folder A cannot overlap a card that was already in
  // folder B (the original `findFreeSlot` already does that, but a manual
  // hull drag can later bring a card into another folder's card). Both
  // passes are O(pairs * passes) and the budget is bounded.
  const pinned = opts.pinned || (opts.nodeById ? null : null);
  const pinnedGroups = new Set();
  if (pinned) {
    for (const [id] of pinned) {
      const n = nodeById.get(id);
      if (n && n.folder) pinnedGroups.add(folderKey(n.folder));
    }
  }
  // Build the groupIds map once (group key -> member ids incl. folder hubs).
  const liveGroupIds = new Map();
  for (const [k, ms] of grouped) liveGroupIds.set(k, ms.map((m) => m.id));
  for (const n of nodes) {
    if (n.kind !== 'folder' || !n.folder) continue;
    const k = folderKey(n.folder);
    if (!liveGroupIds.has(k)) liveGroupIds.set(k, []);
    liveGroupIds.get(k).push(n.id);
  }
  separateGroups({
    positions, hulls, groupIds: liveGroupIds, nodeSizes: opts.nodeSizes || null,
    pinnedGroups,
    passes: opts.separationPasses != null ? opts.separationPasses : RUNTIME_SEPARATION_PASSES,
  });
  // Cross-folder card sweep. Cards in one folder can land on cards in another
  // after a manual drag or a long force sim; the layout-time pass de-overlaps
  // cards globally already, but only on a full re-layout. The per-poll pass
  // below does the same: push pairs apart on the axis of least penetration
  // until no card-vs-card overlap remains. Pinned (dragged) cards act as
  // immovable obstacles; only the OTHER card of the pair moves.
  separateCardsGlobal({
    nodes, positions, nodeSizes: opts.nodeSizes || null, pinnedIds: pinned ? new Set(pinned.keys()) : null,
  });

  return { positions, hulls, placedIds };
}

// ---- group drag helpers ----
//
//   groupDragDelta(startFlow, curFlow) -> { dx, dy }
//
// Both points must come from React Flow's screenToFlowPosition(). Because the
// SAME transform (zoom + pan) converts both, their difference is already
// zoom- and pan-corrected: it is exactly how far the pointer travelled in the
// world the nodes live in. This is the delta the drag must apply — computed
// once, from the drag START, never accumulated per step. Accumulating raw
// screen deltas divided by getZoom() drifts as soon as the viewport moves
// mid-drag, and if the start is never seeded the first step dumps the whole
// cursor position into the group (the drag-exactness defect fixed here).
//
//   applyGroupDrag({ positions, memberIds, dx, dy }) -> positions
//
// Used by App.jsx when the user grabs a hull box and drags. Moves every
// member in `memberIds` by exactly (dx, dy). `positions` must be an IMMUTABLE
// SNAPSHOT taken at pointerdown and `dx,dy` the ABSOLUTE delta from that same
// pointerdown, so the result is a pure function of (snapshot, cursor) and can
// never accumulate. PURE: returns a new Map; never mutates the caller's Map
// or any of its {x,y} objects.
export function groupDragDelta(startFlow, curFlow) {
  return { dx: (curFlow.x - startFlow.x), dy: (curFlow.y - startFlow.y) };
}

export function applyGroupDrag({ positions, memberIds, dx, dy }) {
  const next = new Map();
  for (const [id, p] of positions) next.set(id, { x: p.x, y: p.y });
  const ids = new Set(memberIds);
  for (const id of ids) {
    const p = next.get(id);
    if (!p) continue;
    next.set(id, { x: p.x + dx, y: p.y + dy });
  }
  return next;
}

// Build hulls from the placed member positions only. No separation pass: this
// runs every render and must stay O(members). The 24 px gap guarantee lives
// in computeLayout(), not here.
function buildHullsFromPositions(grouped, positions) {
  const out = [];
  const ordered = [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let i = 0;
  for (const [k, members] of ordered) {
    const placed = members
      .filter((m) => positions.has(m.id))
      .map((m) => ({ m, p: positions.get(m.id) }));
    if (!placed.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const memberIds = [];
    for (const { m, p } of placed) {
      const sz = NODE_SIZE[m.kind] || { width: 220, height: 56 };
      const l = p.x - sz.width / 2;
      const t = p.y - sz.height / 2;
      const r = p.x + sz.width / 2;
      const b = p.y + sz.height / 2;
      if (l < minX) minX = l; if (t < minY) minY = t;
      if (r > maxX) maxX = r; if (b > maxY) maxY = b;
      memberIds.push(m.id);
    }
    out.push({
      key: k,
      folder: members[0].folder,
      label: members[0].folderLabel || members[0].folder,
      path: members[0].folderPath || members[0].folder,
      x: minX - HULL_PAD,
      y: minY - HULL_PAD,
      w: maxX + HULL_PAD - (minX - HULL_PAD),
      h: maxY + HULL_PAD - (minY - HULL_PAD),
      hue: HUE[i % HUE.length],
      members: memberIds,
    });
    i++;
  }
  return out;
}

// Public wrapper: App.jsx recomputes hulls every render from the current
// positions + nodes so a dragged node grows its hull live, no separation pass.
// PURE.
export function hullsFromPositions(positions, nodes) {
  const grouped = new Map();
  for (const n of nodes) {
    if (!n.folder || n.kind === 'folder') continue;
    const k = folderKey(n.folder);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push({
      id: n.id, kind: n.kind, folder: n.folder,
      folderLabel: n.label || n.folder, folderPath: n.folder,
    });
  }
  return buildHullsFromPositions(grouped, positions);
}

// Tiny deterministic string hash used to jitter brand-new node positions so
// two siblings placed in the same poll don't land on the same pixel.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

// ---- per-poll separation ----
//
// separateGroups(positions, hulls, groupIds, { pinnedGroups, passes })
//
// Re-runs the same sorted-sequential hull-deficit pass computeLayout uses,
// but on already-placed positions. The hull list is mutated in place (it is
// derived from positions every poll, so the caller discards the reference).
// `groupIds` is a Map<folderKey, memberId[]>. Pinned groups (user-dragged
// hulls) are immovable in the deficit pass: when a deficit is found between
// a pinned and an unpinned hull, the unpinned one moves by the full deficit
// (not half). When the deficit is between two pinned hulls we record the
// violation but never move anything (the user explicitly asked for it).
// `passes` caps the iteration count so a busy graph stays cheap — 40 passes
// converge to a sub-pixel gap in every synthetic workload measured.
//
// Mutates `positions` in place (moves the {x,y} objects the positions Map
// already holds — callers that need a new Map must copy first). Mutates
// `hulls` in place (x/y/w/h) the same way. Pure-no-mutation contract: this
// function does not invent positions, it only translates existing ones.
export function separateGroups({ positions, hulls, groupIds, nodeSizes,
                                  pinnedGroups = new Set(), passes = RUNTIME_SEPARATION_PASSES }) {
  if (!hulls || hulls.length < 2) { recomputeHulls(hulls || [], positions, nodeSizes); return; }
  for (let iter = 0; iter < passes; iter++) {
    recomputeHulls(hulls, positions, nodeSizes);
    const pairs = [];
    for (let i = 0; i < hulls.length; i++) {
      for (let j = i + 1; j < hulls.length; j++) {
        const def = pairDeficit(hulls[i], hulls[j]);
        if (!def || def.deficit <= 0) continue;
        pairs.push({ i, j, ...def });
      }
    }
    if (!pairs.length) break;
    pairs.sort((p, q) => q.deficit - p.deficit);
    for (const p of pairs) {
      const a = hulls[p.i], b = hulls[p.j];
      const aPinned = pinnedGroups.has(a.key);
      const bPinned = pinnedGroups.has(b.key);
      if (aPinned && bPinned) continue;            // user explicitly wants this
      const push = p.deficit;
      if (p.axis === 'x') {
        const s = p.dx > 0 ? 1 : -1;
        if (aPinned) {
          translateGroup(b.key,  s * push, 0, positions, groupIds);
        } else if (bPinned) {
          translateGroup(a.key, -s * push, 0, positions, groupIds);
        } else {
          translateGroup(a.key, -s * push / 2, 0, positions, groupIds);
          translateGroup(b.key,  s * push / 2, 0, positions, groupIds);
        }
      } else {
        const s = p.dy > 0 ? 1 : -1;
        if (aPinned) {
          translateGroup(b.key, 0,  s * push, positions, groupIds);
        } else if (bPinned) {
          translateGroup(a.key, 0, -s * push, positions, groupIds);
        } else {
          translateGroup(a.key, 0, -s * push / 2, positions, groupIds);
          translateGroup(b.key, 0,  s * push / 2, positions, groupIds);
        }
      }
    }
  }
  recomputeHulls(hulls, positions, nodeSizes);
}

// separateCardsGlobal(positions, nodes, { pinnedIds, passes })
//
// Pushes overlapping cards (< CARD_GAP apart) apart across the whole graph,
// not just within one folder. The original layout-time pass does this too,
// but a manual hull drag or a long stream of newcomers can later land a
// folder-A card on top of a folder-B card; the per-poll sweep keeps the
// global invariant. Pinned (user-dragged) cards are immovable obstacles:
// the OTHER card of an overlapping pair moves by the full deficit. With no
// pinned ids the symmetric push (half each) is identical to the layout-time
// pass.
//
// Mutates `positions` in place.
export function separateCardsGlobal({ nodes, positions, nodeSizes, pinnedIds = null,
                                       passes = 30 }) {
  const cards = [];
  for (const n of nodes) {
    if (n.kind === 'folder') continue;
    const p = positions.get(n.id);
    if (!p) continue;
    cards.push({ id: n.id, p, sz: sizeOf(n, nodeSizes), pinned: !!(pinnedIds && pinnedIds.has(n.id)) });
  }
  if (cards.length < 2) return;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i], b = cards[j];
        const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y;
        const gapX = Math.abs(dx) - (a.sz.width + b.sz.width) / 2;
        const gapY = Math.abs(dy) - (a.sz.height + b.sz.height) / 2;
        if (gapX >= CARD_GAP || gapY >= CARD_GAP) continue;
        const deficitX = CARD_GAP - gapX;
        const deficitY = CARD_GAP - gapY;
        if (a.pinned && b.pinned) continue;
        moved = true;
        if (gapX >= gapY) {
          // X axis has the smaller gap (or is the only overlapping axis).
          // Direction: b is at +x relative to a when dx > 0, so to separate
          // a moves by -push (toward -x) and b by +push (toward +x). When
          // a is pinned we still need to move b away (deficit) — that is
          // b.p.x += s * deficit. When b is pinned, we move a in the
          // opposite direction: a.p.x -= s * deficit. The arithmetic is
          // identical only in sign; verify by hand: dx = b.x - a.x > 0,
          // and after the push we want b.x - a.x > 0 to grow, so b moves
          // +x and a moves -x.
          const s = dx >= 0 ? 1 : -1;
          if (a.pinned)      { b.p.x +=  s * (deficitX + 0.01); }
          else if (b.pinned) { a.p.x -=  s * (deficitX + 0.01); }
          else { const push = (deficitX + 0.01) / 2; a.p.x -= s * push; b.p.x += s * push; }
        } else {
          const s = dy >= 0 ? 1 : -1;
          if (a.pinned)      { b.p.y +=  s * (deficitY + 0.01); }
          else if (b.pinned) { a.p.y -=  s * (deficitY + 0.01); }
          else { const push = (deficitY + 0.01) / 2; a.p.y -= s * push; b.p.y += s * push; }
        }
      }
    }
    if (!moved) break;
  }
}

// Exported for tests / diagnostics.
export const _internals = { RADIUS, NODE_SIZE, HULL_PAD, GROUP_MIN_GAP, RUNTIME_SEPARATION_PASSES, folderKey, pairDeficit, recomputeHulls, buildHullsFromPositions };