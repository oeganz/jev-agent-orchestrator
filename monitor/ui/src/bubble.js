// Pure helpers for the activity-bubble overlay.
//
//   formatAge(seconds)         -> "12s" | "4m" | "2h"
//   truncateText(s, max)        -> "..." truncated string
//   shouldShowBubble(state)     -> boolean (active|monitoring only)
//   idleSubline(age, branch)    -> "idle · 8m · main"
//
// Importable in node (for tests) and the browser (App.jsx). No DOM, no React.
// All inputs are plain values so the helpers stay trivially testable.
const ACTIVE_STATES = new Set(['active', 'monitoring']);

// formatAge: seconds-under-a-minute -> "12s"; minute -> "4m"; hour -> "2h".
// Pure: clamps negative deltas (future ts) to 0s so the bubble never renders
// "−3s" or any sign. Returns a string with the suffix, never a number.
export function formatAge(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '0s';
  if (s < 60) return Math.floor(s) + 's';
  if (s < 60 * 60) return Math.floor(s / 60) + 'm';
  return Math.floor(s / (60 * 60)) + 'h';
}

// truncateText: keeps under `max` codepoints and appends an ellipsis when
// truncating. Returns the input unchanged when it already fits.
export function truncateText(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  if (max <= 1) return '…';
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

// shouldShowBubble: only active and monitoring cards get a bubble. Idle and
// every other state (including 'container' for branch / folder-shaped nodes)
// render no bubble.
export function shouldShowBubble(state) {
  return ACTIVE_STATES.has(state);
}

// idleSubline: "idle · <age> · <branch>". When the branch is missing we elide
// the trailing separator so the rendered line stays "idle · 8m" rather than
// "idle · 8m · ". Both missing returns plain "idle".
export function idleSubline(age, branch) {
  const a = (age == null || age === '') ? '' : String(age);
  const b = (branch == null || branch === '') ? '' : String(branch);
  if (!a && !b) return 'idle';
  if (!a) return 'idle · ' + b;
  if (!b) return 'idle · ' + a;
  return 'idle · ' + a + ' · ' + b;
}

// secondsSince(ts, now): how many seconds elapsed between `ts` (ms epoch) and
// `now` (ms epoch). Returns 0 for future ts so the bubble ages forward only.
// Provided here so the App.jsx ticker and tests share one definition.
export function secondsSince(ts, now) {
  const t = Number(ts);
  const n = Number(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 0;
  return Math.max(0, (n - t) / 1000);
}

// idleAgeSeconds(tsIdle, now): same as secondsSince but null-safe on a missing
// tsIdle. Used by App.jsx for idle card sub-lines.
export function idleAgeSeconds(tsIdle, now) {
  if (tsIdle == null) return null;
  return secondsSince(tsIdle, now);
}

// bubbleLines(activity, ageSec): pure renderer for the bubble's line content.
// Returns an array of line descriptors the Bubble component maps to JSX:
//   { kind: 'action' | 'said', text: string, age: string }[]
//
// Contract: every bubble that has any activity MUST show an age. The
// original implementation only put the age on the action line, so a said-only
// bubble (e.g. Orca terminals with no tool_use) rendered the agent's last
// words but no age. This helper enforces: action+said => age on the action
// line (per the original design); said-only => age on the said line. Empty
// activity => no lines.
export function bubbleLines(activity, ageSec) {
  if (!activity || (!activity.action && !activity.said)) return [];
  // formatAge already clamps negative / NaN / Infinity to '0s', so a single
  // call covers every ageSec shape the Bubble can pass in.
  const age = formatAge(ageSec);
  const out = [];
  if (activity.action) out.push({ kind: 'action', text: String(activity.action), age });
  if (activity.said)   out.push({ kind: 'said',   text: String(activity.said),   age });
  return out;
}

// accentFor(data): the per-card accent colour that the card already uses for
// its ring/role/provider. Mirrors the `colorOf(d)` helper in App.jsx so the
// bubble can reuse the existing palette (no new colours). Exposed here so
// the contract is testable without a DOM. Roles win over generic agent
// blue; folder/branch/hermes/session kinds use their own colours; unknown
// kinds fall back to the agent blue. `data` is the card's `data` object
// (kind, role, state, etc.). Pure: never reads the DOM.
const ACCENT = {
  folder: '#cfd9e6', branch: '#8ea4bf',
  agent: '#63a6ff', hermes: '#f07ab8', session: '#dbe4f0',
};
const ROLE_ACCENT = {
  planner: '#9a8cff', engineer: '#63a6ff', tester: '#4ecb8c', devops: '#e0a33e',
};
export function accentFor(data) {
  const d = (data && typeof data === 'object') ? data : {};
  if (d.kind === 'folder') return ACCENT.folder;
  if (d.kind === 'branch') return ACCENT.branch;
  if (d.kind === 'hermes') return ACCENT.hermes;
  if (d.kind === 'session') return ACCENT.session;
  if (d.role && ROLE_ACCENT[d.role]) return ROLE_ACCENT[d.role];
  return ACCENT.agent;
}

// Read the persisted toggle from localStorage. Wrapped in try/catch by the
// caller in App.jsx; the helper itself never throws (a blocked storage still
// sees the supplied fallback).
export function loadBubblePref(key, fallback) {
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    try {
      const v = globalThis.localStorage.getItem(key);
      if (v === null) return fallback;
      if (v === 'false') return false;
      if (v === 'true') return true;
      return fallback;
    } catch { return fallback; }
  }
  return fallback;
}

export function saveBubblePref(key, value) {
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    try { globalThis.localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore */ }
  }
}

// Exposed for tests only.
export const _internals = { ACTIVE_STATES };

// ---- bubble placement ----
//
//   placeBubbles({ cards, bubbles, viewport })
//     -> { placements: Map<ownerId, {side, x, y, w, h}> }
//
// Pure: chooses, for every bubble, a placement side relative to its owner
// card that collides with no other card and no other bubble. The owner card
// is never moved; the helper is the one the UI calls to decide where to
// draw each bubble, and it never has write access to card positions.
//
// `cards` is an array of { id, x, y, w, h, ownerId? } describing every card
// currently on the canvas. `bubbles` is an array of { ownerId } (one per
// active/monitoring card whose bubble is currently shown). `viewport` is
// { width, height } in flow space; the helper clamps the bubble so it stays
// on screen.
//
// The side preference order is [above, below, right, left] — matches the
// "comic speech bubble" affordance the current CSS already styles. The
// helper picks the FIRST side whose anchor is not inside any other card
// (with a configurable gap) and whose rendered bubble rect does not
// intersect any other bubble or any non-owner card. A bubble that cannot
// be placed on any side without colliding keeps its preferred (above)
// anchor, but the helper still reports the collision so the caller can
// decide to hide the bubble on a particularly crowded frame.
export const BUBBLE_GAP = 16;           // clear space between a bubble and any non-owner card
export const BUBBLE_DEFAULT_W = 200;   // estimated bubble width when no measured size is supplied
export const BUBBLE_DEFAULT_H = 48;    // estimated bubble height (action + said + padding)
export const BUBBLE_SIDES = ['above', 'below', 'right', 'left'];

// candidateRect(side, owner, bw, bh, gap): top-left rect the bubble WOULD
// occupy if placed on `side` of `owner`. `above` / `below` keep the bubble
// horizontally centred on the owner; `right` / `left` keep it vertically
// centred. `gap` is the minimum space kept between the bubble and the
// owner card (matches the 14 px gap the CSS already leaves for the leader
// line — leaving 4 px clear of the *card rect* on top of that is the
// BUBBLE_GAP the tests pin).
function candidateRect(side, owner, bw, bh, gap) {
  const cx = owner.x, cy = owner.y;
  const hw = owner.w / 2, hh = owner.h / 2;
  if (side === 'above') {
    return { x: cx - bw / 2, y: cy - hh - gap - bh, w: bw, h: bh };
  }
  if (side === 'below') {
    return { x: cx - bw / 2, y: cy + hh + gap, w: bw, h: bh };
  }
  if (side === 'right') {
    return { x: cx + hw + gap, y: cy - bh / 2, w: bw, h: bh };
  }
  return { x: cx - hw - gap - bw, y: cy - bh / 2, w: bw, h: bh }; // 'left'
}

// rectOverlap(a, b, gap): true when a and b are CLOSER than `gap` apart
// (or overlapping). Used to enforce the BUBBLE_GAP clearance floor.
// The four "separated by gap" checks are: a is fully left of b with gap
// (a.x + a.w + gap <= b.x), a is fully right of b with gap, a is fully
// above b with gap, a is fully below b with gap. ANY of those is enough
// to clear; we return true when NONE holds.
function rectOverlap(a, b, gap = 0) {
  const sepX = a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x;
  const sepY = a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
  return !(sepX || sepY);
}

function rectInsideOther(a, owner, b) {
  // The owner card and its bubble can share a small border (the leader
  // line crosses the gap), but the bubble's interior must not extend INTO
  // any other card's interior. We allow the bubble rect to sit up to
  // BUBBLE_GAP px from a non-owner card without counting as overlap.
  if (b.id === owner.id) return false;
  return rectOverlap(a, b, BUBBLE_GAP);
}

// Push the bubble rect further out along its chosen side relative to the
// owner card. The side NEVER changes — only the rect's anchor translates —
// so the leader line stays attached to the same side of the owner. The
// caller uses this when the initial candidate position collides with a
// non-owner card; pushing finds a clear position along the same axis
// without flipping the side (which would visually yank the leader line
// to the other side of the card).
function pushOut(side, rect, by) {
  const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (side === 'above')      r.y -= by;
  else if (side === 'below') r.y += by;
  else if (side === 'right') r.x += by;
  else                       r.x -= by;   // 'left'
  return r;
}

// Clamp the rect so it stays inside the viewport. Returns the same shape
// (the helper never grows the rect). The placement may be entirely off
// the viewport if the bubble cannot fit — that's fine, the bubble simply
// won't be visible, and the leader line still works because the side is
// preserved.
function clampToViewport(rect, viewport) {
  if (!viewport || !viewport.width || !viewport.height) return rect;
  const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (r.x < 0) r.x = 0;
  if (r.y < 0) r.y = 0;
  if (r.x + r.w > viewport.width) r.x = viewport.width - r.w;
  if (r.y + r.h > viewport.height) r.y = viewport.height - r.h;
  return r;
}

// When a candidate placement on a given side collides, push the rect out
// along the same axis (up to MAX_PUSH total) and pick the first pushed
// position that clears every non-owner card AND every already-placed
// bubble (BUBBLE_GAP clearance). The side is preserved across pushes, so
// the leader line still points at the owner card. Returns null when no
// pushed position clears within the budget or the viewport clamps the
// rect against a wall — the caller falls back to the "all sides blocked,
// report collision" path. This is the "if no side is free, push the
// bubble further out along the chosen axis" arm of the spec: the helper
// never emits a placement that overlaps a non-owner card, but it also
// never gives up on the first side before exhausting the push budget.
const PUSH_STEP = 24;
const MAX_PUSH = 800;
function pushUntilClear(side, initial, owner, w, h, gap, cards, placedRects, viewport) {
  let pushed = clampToViewport(initial, viewport);
  const steps = Math.floor(MAX_PUSH / PUSH_STEP);
  for (let i = 0; i < steps; i++) {
    const next = pushOut(side, pushed, PUSH_STEP);
    const clamped = clampToViewport(next, viewport);
    // The clamp brought us back to the same position: we've hit the
    // viewport wall. No more pushing will change anything.
    if (clamped.x === pushed.x && clamped.y === pushed.y) return null;
    pushed = clamped;
    const candidate = { x: pushed.x, y: pushed.y, w, h };
    let collides = false;
    for (const c of cards) {
      if (c.id === owner.id) continue;
      if (rectOverlap(candidate, c, BUBBLE_GAP)) { collides = true; break; }
    }
    if (collides) continue;
    for (const pr of placedRects) {
      if (pr.ownerId === owner.id) continue;
      if (rectOverlap(candidate, pr.rect, BUBBLE_GAP)) { collides = true; break; }
    }
    if (!collides) return candidate;
  }
  return null;
}

// ---- sticky + nearest placement (prev-aware) ----
//
// A placement is described relative to its owner by three numbers:
//   side  : above | below | right | left
//   slide : offset of the bubble's centre ALONG the owner edge, measured from
//           the owner centre (x for above/below, y for right/left)
//   dist  : clear distance between the bubble and the owner edge (>= gap)
// Carrying that triple (not just absolute x/y) lets a sticky bubble FOLLOW its
// owner card when the card moves, keeping the same side and the same slot on
// that edge, instead of being left behind or re-picked from scratch.
export const SLIDE_STEP = 12;           // resolution of the slide-along-edge search

function edgeParams(side, owner, rect) {
  const hw = owner.w / 2, hh = owner.h / 2;
  if (side === 'above') return { slide: rect.x + rect.w / 2 - owner.x, dist: (owner.y - hh) - (rect.y + rect.h) };
  if (side === 'below') return { slide: rect.x + rect.w / 2 - owner.x, dist: rect.y - (owner.y + hh) };
  if (side === 'right') return { slide: rect.y + rect.h / 2 - owner.y, dist: rect.x - (owner.x + hw) };
  return { slide: rect.y + rect.h / 2 - owner.y, dist: (owner.x - hw) - (rect.x + rect.w) }; // left
}

function rectFromParams(side, owner, w, h, slide, dist) {
  const hw = owner.w / 2, hh = owner.h / 2;
  if (side === 'above') return { x: owner.x + slide - w / 2, y: owner.y - hh - dist - h, w, h };
  if (side === 'below') return { x: owner.x + slide - w / 2, y: owner.y + hh + dist, w, h };
  if (side === 'right') return { x: owner.x + hw + dist, y: owner.y + slide - h / 2, w, h };
  return { x: owner.x - hw - dist - w, y: owner.y + slide - h / 2, w, h };           // left
}

function insideViewport(rect, viewport) {
  if (!viewport || !viewport.width || !viewport.height) return true;
  const e = 0.001;
  return rect.x >= -e && rect.y >= -e
      && rect.x + rect.w <= viewport.width + e && rect.y + rect.h <= viewport.height + e;
}

// collidesAny: the SAME collision tests the first-appearance path uses (every
// non-owner card with BUBBLE_GAP clearance, every other bubble already placed).
function collidesAny(rect, owner, cards, placedRects) {
  for (const c of cards) {
    if (c.id === owner.id) continue;
    if (rectInsideOther(rect, owner, c)) return true;
  }
  for (const pr of placedRects) {
    if (pr.ownerId === owner.id) continue;
    if (rectOverlap(rect, pr.rect, BUBBLE_GAP)) return true;
  }
  return false;
}

// attachedOk: the rect must still be a bubble OF this owner: on its side at a
// sane distance, and overlapping the owner's extent along the edge (so the
// tether stays short). Guards an absolute `prev` whose owner has since moved.
function attachedOk(side, owner, rect, gap) {
  const { slide, dist } = edgeParams(side, owner, rect);
  if (dist < gap - 0.5 || dist > gap + MAX_PUSH + 0.5) return false;
  const horiz = side === 'above' || side === 'below';
  const half = (horiz ? owner.w : owner.h) / 2 + (horiz ? rect.w : rect.h) / 2;
  return Math.abs(slide) <= half;
}

// The sticky rect for a bubble: the previous placement re-expressed against
// the CURRENT owner (follows the owner when prev carries slide/dist), or the
// previous absolute rect when only {side,x,y} is known.
function stickyRect(prev, owner, w, h) {
  if (Number.isFinite(prev.slide) && Number.isFinite(prev.dist)) {
    return rectFromParams(prev.side, owner, w, h, prev.slide, prev.dist);
  }
  return { x: prev.x, y: prev.y, w, h };
}

// Candidate rects on one side: slides along the owner edge, each at the base
// distance plus pushes further out along the axis (the legacy push arm),
// clamped to the viewport as the legacy path does.
function candidatesFor(side, owner, w, h, gap, viewport) {
  const out = [];
  const horiz = side === 'above' || side === 'below';
  const crossHalf = (horiz ? owner.w : owner.h) / 2 + (horiz ? w : h) / 2;
  const nSlide = Math.floor(crossHalf / SLIDE_STEP);
  const nPush = Math.floor(MAX_PUSH / PUSH_STEP);
  for (let si = -nSlide; si <= nSlide; si++) {
    const slide = si * SLIDE_STEP;
    for (let pi = 0; pi <= nPush; pi++) {
      const rect = clampToViewport(rectFromParams(side, owner, w, h, slide, gap + pi * PUSH_STEP), viewport);
      out.push({ side, rect, pi });
    }
  }
  return out;
}

// placeBubbles({ cards, bubbles, viewport, prev })
//
// `prev` (optional) is a Map<ownerId, {side, x, y, [slide, dist], [collision]}>
// of the CURRENT placements. It makes the placement STICKY and NEAREST:
//   1. a bubble whose previous position still fits (no collision with any
//      non-owner card / other bubble, inside the viewport, still attached to
//      its owner) keeps that side and anchor exactly;
//   2. otherwise it moves to the collision-free candidate NEAREST to its
//      previous anchor (Euclidean, rect centre); candidates are the slides
//      along each side's owner edge plus pushes outward; ties go to the
//      current side, then the fixed BUBBLE_SIDES order;
//   3. a bubble with no prev (first appearance) uses the legacy first-fit
//      above-first order, so a new bubble still appears centred above.
// A bubble with no free position at all comes back with `collision: true`
// (the caller suppresses it), exactly as before.
export function placeBubbles({ cards, bubbles, viewport = null,
                               bubbleW = BUBBLE_DEFAULT_W, bubbleH = BUBBLE_DEFAULT_H,
                               gap = BUBBLE_GAP, prev = null } = {}) {
  const placements = new Map();
  if (!cards || !cards.length || !bubbles || !bubbles.length) return placements;
  const cardById = new Map();
  for (const c of cards) cardById.set(c.id, c);
  const placedRects = [];
  const results = new Map();            // ownerId -> placement (filled out of order)
  // Per-bubble size: the caller-supplied size for THIS bubble, else default.
  const sizeOf = (b) => ({ w: (b.size && b.size.w) || bubbleW, h: (b.size && b.size.h) || bubbleH });
  const record = (ownerId, owner, side, rect, collision) => {
    const ep = edgeParams(side, owner, rect);
    results.set(ownerId, {
      side, x: rect.x, y: rect.y, w: rect.w, h: rect.h,
      collision: !!collision, slide: ep.slide, dist: ep.dist,
    });
    if (!collision) placedRects.push({ ownerId, rect });
  };

  // Pass 1: every bubble whose previous position still fits keeps it. Done
  // for all bubbles BEFORE any bubble moves, so a mover can never steal the
  // slot a stationary neighbour is sitting in.
  const movers = [];
  const anchors = new Map();            // ownerId -> prev sticky rect (nearest ranking origin)
  for (const b of bubbles) {
    const owner = cardById.get(b.ownerId);
    if (!owner) continue;
    const { w, h } = sizeOf(b);
    const pv = prev && prev.get ? prev.get(b.ownerId) : null;
    if (pv && !pv.collision && BUBBLE_SIDES.includes(pv.side)
        && Number.isFinite(pv.x) && Number.isFinite(pv.y)) {
      const rect = stickyRect(pv, owner, w, h);
      anchors.set(b.ownerId, rect);
      if (insideViewport(rect, viewport) && attachedOk(pv.side, owner, rect, gap)
          && !collidesAny(rect, owner, cards, placedRects)) {
        record(b.ownerId, owner, pv.side, rect, false);
        continue;
      }
    }
    movers.push(b);
  }

  // Pass 2: bubbles that must move (or are new).
  for (const b of movers) {
    const owner = cardById.get(b.ownerId);
    const { w, h } = sizeOf(b);
    const anchor = anchors.get(b.ownerId);
    let chosen = null;
    if (anchor) {
      // Nearest-first over every side's slide/push candidates.
      const curSide = prev.get(b.ownerId).side;
      const ax = anchor.x + anchor.w / 2, ay = anchor.y + anchor.h / 2;
      const cands = [];
      BUBBLE_SIDES.forEach((side, sideIdx) => {
        for (const c of candidatesFor(side, owner, w, h, gap, viewport)) {
          const dx = c.rect.x + w / 2 - ax, dy = c.rect.y + h / 2 - ay;
          cands.push({ side, rect: c.rect, pi: c.pi, sideIdx,
                       d2: dx * dx + dy * dy, cur: side === curSide ? 0 : 1 });
        }
      });
      cands.sort((p, q) => (p.d2 - q.d2) || (p.cur - q.cur) || (p.sideIdx - q.sideIdx) || (p.pi - q.pi));
      for (const c of cands) {
        if (collidesAny(c.rect, owner, cards, placedRects)) continue;
        chosen = { side: c.side, rect: c.rect };
        break;
      }
    } else {
      // First appearance: legacy first-fit, above first, centred then pushed.
      for (const side of BUBBLE_SIDES) {
        const initial = candidateRect(side, owner, w, h, gap);
        const initialClamped = clampToViewport(initial, viewport);
        if (!collidesAny(initialClamped, owner, cards, placedRects)) {
          chosen = { side, rect: initialClamped }; break;
        }
        // Push outward along the same axis (side preserved) until clear.
        const pushed = pushUntilClear(side, initial, owner, w, h, gap, cards, placedRects, viewport);
        if (pushed) { chosen = { side, rect: pushed }; break; }
      }
    }
    if (chosen) {
      record(b.ownerId, owner, chosen.side, chosen.rect, false);
    } else {
      // No collision-free position: report it (the caller hides the bubble).
      const rect = clampToViewport(candidateRect('above', owner, w, h, gap), viewport);
      record(b.ownerId, owner, 'above', rect, true);
    }
  }

  // Emit in the caller's bubble order.
  for (const b of bubbles) {
    const r = results.get(b.ownerId);
    if (r) placements.set(b.ownerId, r);
  }
  return placements;
}

// Exposed for tests only.
export const _internals2 = { BUBBLE_GAP, BUBBLE_DEFAULT_W, BUBBLE_DEFAULT_H, BUBBLE_SIDES, PUSH_STEP, MAX_PUSH, SLIDE_STEP };

// ---- identity layer (D1/D2/D3/D4) ----
//
// These helpers give every card an OWNER identity (a stable colour derived
// from the nodeId), compute a routed tether path between a bubble and its
// owner card, decide whether a bubble should be dimmed under the current
// hover, and classify first-collision bubbles for the post-render
// reconciliation pass. All helpers are pure (no DOM, no React) so the
// tests can pin their contracts without spinning up the UI.
//
// IDENTITY_SAT/IDENTITY_LIGHT are the HSL saturation and lightness pinned
// by the spec: every identity colour is a vivid mid-saturation tone that
// reads against both the dark card surface and the bubble halo, so the
// border, tether and socket all read as "this owner's colour" at a glance.
// 68% saturation is enough chroma to be distinct; 64% lightness keeps the
// colour well above the surface so the identity stays readable even on a
// cluster of dark cards.
export const IDENTITY_SAT = 68;
export const IDENTITY_LIGHT = 64;
// 137.508 degrees is the golden angle — distributing node ids across the
// wheel by this offset keeps neighbouring ids (e.g. session-1, session-2)
// on opposite sides of the wheel, so two adjacent ids do not collapse
// into visually-similar hues.
const GOLDEN_ANGLE_DEG = 137.508;

// FNV-1a 32-bit hash. Lightweight, allocation-free for the small ids the
// UI produces (UUIDs, slugs, server-generated ids). The multiply + xor mix
// spreads the bits evenly so ids that differ by only a letter land on
// wildly different hues.
function fnv1a(str) {
  let h = 2166136261 >>> 0;            // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // Math.imul gives a signed 32-bit multiply (C-like), then >>> 0 keeps
    // it unsigned so the result stays in [0, 2^32).
    h = Math.imul(h, 16777619) >>> 0;  // FNV prime
  }
  return h;
}

// hueFor(nodeId): a deterministic hue for the given node id. Falls back to
// a 0-derived hue (red) for the null/empty case so the helper never
// throws — important for code paths that build the colour before the node
// is on screen.
export function hueFor(nodeId) {
  const key = (nodeId == null) ? '' : String(nodeId);
  const h = fnv1a(key);
  // Normalise to [0,1), then multiply by the golden angle and reduce
  // modulo 360 so every hue lives in [0, 360).
  const frac = h / 0x1_0000_0000;
  const hue = (frac * GOLDEN_ANGLE_DEG) % 360;
  return hue;
}

// identityColor(nodeId): the per-card identity colour string the CSS
// consumes. Format "hsl(h 68% 64%)" — the helper fills hue and lets the
// caller pass it through CSS color-mix() at 50% for borders/tails
// (matching the existing --bubble-accent treatment).
export function identityColor(nodeId) {
  const hue = hueFor(nodeId);
  return 'hsl(' + hue + ' ' + IDENTITY_SAT + '% ' + IDENTITY_LIGHT + '%)';
}

// bubbleDim(hoverId, nodeId): true when the bubble belongs to a non-hovered
// card. hoverId === null means "no hover", in which case every bubble is
// un-dimmed (false). Otherwise only the hovered card's own bubble stays
// un-dimmed; everything else dims so the user can read the active one.
// Pure: same shape every call, no globals.
export function bubbleDim(hoverId, nodeId) {
  if (hoverId == null) return false;
  return hoverId !== nodeId;
}

// firstCollision(bubbles, cards): the FIRST bubble whose rendered rect
// intersects a NON-OWNER card, or null when no such collision exists.
// The helper accepts the rendered rect in flow space (whatever the
// post-render reconciliation measured off the DOM); the owner card is
// excluded because every bubble MUST sit just outside its owner (the
// leader / tether reaches toward the socket).
//
// `bubbles` is an array of { id, ownerId, rect: {x,y,w,h} } (the helper
// does not require placement; it works on whatever rect list the caller
// supplies). `cards` is an array of { id, rect: {x,y,w,h} }.
//
// Returns the offending bubble id, or null when no collision is found.
// The contract is intentionally one-at-a-time so the reconciliation loop
// in App.jsx can call it in a fixed-point loop until it returns null.
function rectIntersects(a, b) {
  // Match the acceptance test's "gap < 1" semantics: bubble and card
  // are considered overlapping when their axis-aligned gap is below 1
  // flow unit on both axes. The strict-overlap test in the unit file is
  // updated to match — see bubble.test.mjs. The slack absorbs
  // sub-pixel / sub-flow rounding error (React Flow's measured widths
  // come back in CSS pixels and round differently across re-measures).
  const slack = 1;
  return a.x < b.x + b.w + slack && a.x + a.w > b.x - slack
      && a.y < b.y + b.h + slack && a.y + a.h > b.y - slack;
}
export function firstCollision(bubbles, cards) {
  if (!bubbles || !bubbles.length) return null;
  if (!cards || !cards.length) return null;
  // Index cards by id for the inner loop so the helper stays O(bubbles *
  // cards) like the helpers it complements.
  const cardById = new Map();
  for (const c of cards) cardById.set(c.id, c);
  for (const b of bubbles) {
    const owner = cardById.get(b.ownerId);
    for (const c of cards) {
      if (c.id === b.ownerId) continue;       // owner's own card is allowed
      if (rectIntersects(b.rect, c.rect)) return b.id;
    }
  }
  return null;
}

// routeTether({ from, to, blockers, step, maxPush }) -> { d, points }
//
// from = bubble tail tip, to = card socket, both {x,y} in flow space.
// Returns an SVG path "d" string plus a polyline samples array. The path
// is straight (two points, M start, L end) when the straight segment
// clears every blocker. When a blocker straddles the segment, ONE bend
// is inserted perpendicular to the segment, on the roomier side
// (positive vs negative perpendicular chosen by the local free room). If
// even the bent path still crosses a blocker, the helper pushes the bend
// point further along the perpendicular until it clears, the same
// bounded-loop shape placeBubbles uses. The helper never returns null:
// when maxPush is exhausted, the path falls back to a stretched straight
// line so the bubble still has a line to draw.
//
// `blockers` is an array of { x, y, w, h } flow-space rects (the same
// non-owner card rects the placement pass used). `step` (default 18)
// controls the perpendicular push resolution; `maxPush` (default 400)
// caps the total perpendicular distance the bend can travel.
//
// The 18 px step + 400 px budget means the bend tries up to ~22 push
// steps. That is well under one render tick on the typical 20-node
// workspace, and the per-frame budget stays bounded even with dozens of
// bubbles in flight.
export function routeTether({ from, to, blockers, step = 18, maxPush = 400 } = {}) {
  // Defensive: same shape on every input so the helper is safe to call
  // before the bubble / card has measured. A missing endpoint returns a
  // degenerate single point (the render still gets a path string).
  if (!from || !to) return { d: '', points: [] };
  const fx = Number(from.x), fy = Number(from.y);
  const tx = Number(to.x),   ty = Number(to.y);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)
      || !Number.isFinite(tx) || !Number.isFinite(ty)) {
    return { d: '', points: [] };
  }
  // Direct line + sampled along the path: whether the bend will land
  // outside every blocker is decided by sampling the polyline (each
  // segment with SAMPLES points), not by analytic endpoint tests, so a
  // diagonally-large blocker mid-segment cannot slip past.
  const segClear = (ax, ay, bx, by) => {
    if (!blockers || !blockers.length) return true;
    const SAMPLES = 32;
    for (let k = 1; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const sx = ax + (bx - ax) * t;
      const sy = ay + (by - ay) * t;
      for (const r of blockers) {
        if (sx > r.x && sx < r.x + r.w && sy > r.y && sy < r.y + r.h) {
          return false;
        }
      }
    }
    return true;
  };
  // Straight segment clears: emit it as two points (M, L).
  if (segClear(fx, fy, tx, ty)) {
    const points = [{ x: fx, y: fy }, { x: tx, y: ty }];
    return { d: buildPath(points), points };
  }
  // The segment crosses at least one blocker: find the perpendicular
  // axis and pick the side with the larger free room before the wall.
  const dx = tx - fx, dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector (rotated 90 degrees CCW).
  const px = -dy / len, py = dx / len;
  // Side sign: +1 = one perpendicular direction, -1 = the other.
  // Pick the side that opens up more room before hitting a card
  // rect — measured as the LARGEST perpendicular distance from the
  // midpoint to any blocker edge along `px,py`.
  const midX = (fx + tx) / 2, midY = (fy + ty) / 2;
  let bestDist = 0, bestSide = 1;
  for (const sign of [1, -1]) {
    for (let d = step; d <= maxPush; d += step) {
      const sx = midX + px * sign * d, sy = midY + py * sign * d;
      let inside = false;
      for (const r of blockers) {
        if (sx > r.x && sx < r.x + r.w && sy > r.y && sy < r.y + r.h) { inside = true; break; }
      }
      if (inside) break;
      bestDist = d; bestSide = sign;
    }
  }
  // Push along the chosen side until BOTH segments clear every blocker
  // (bounded by maxPush). If maxPush is exhausted, fall back to a single
  // perpendicular offset (the best room before a blocker that we
  // measured), so the helper always returns a path.
  let used = bestDist || step;
  let points;
  for (let attempt = used; attempt <= maxPush; attempt += step) {
    const cx = midX + px * bestSide * attempt;
    const cy = midY + py * bestSide * attempt;
    points = [{ x: fx, y: fy }, { x: cx, y: cy }, { x: tx, y: ty }];
    // Both segments must clear. Sample each.
    const c0 = segClear(fx, fy, cx, cy);
    const c1 = segClear(cx, cy, tx, ty);
    if (c0 && c1) return { d: buildPath(points), points };
  }
  // Fallback: a perpendicular offset at `used` (the last clear point
  // before a blocker). The path may still cross a blocker when the
  // perpendicular room is tiny; the bubble is already hidden in that
  // case so the artefact stays invisible. Returning a path (never null)
  // keeps the renderer's contract simple.
  const cx = midX + px * bestSide * used;
  const cy = midY + py * bestSide * used;
  points = [{ x: fx, y: fy }, { x: cx, y: cy }, { x: tx, y: ty }];
  return { d: buildPath(points), points };
}

// buildPath(points): turn an array of {x,y} into an SVG "M x y L x y L…"
// path. Used by routeTether and exported only for tests. Kept private
// otherwise.
function buildPath(points) {
  if (!points || !points.length) return '';
  let d = 'M ' + points[0].x + ' ' + points[0].y;
  for (let i = 1; i < points.length; i++) d += ' L ' + points[i].x + ' ' + points[i].y;
  return d;
}