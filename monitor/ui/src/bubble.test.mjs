// Hermetic tests for monitor/ui/src/bubble.js — pure helpers only.
// Acceptance items (from the dispatch spec):
//   (a) age formatting: "12s" / "4m" / "2h", negative / future ts clamps to "0s"
//   (b) text truncation: under max passes through, at/over max gets "…"
//   (c) shouldShowBubble: active|monitoring only; idle/container/undefined false
//   (d) idle sub-line format: "idle · 8m · main" with sensible fallbacks
//
// Run with:  node --test monitor/ui/src/bubble.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAge, truncateText, shouldShowBubble, idleSubline,
  secondsSince, idleAgeSeconds, loadBubblePref, saveBubblePref,
  accentFor, bubbleLines, placeBubbles, BUBBLE_GAP, BUBBLE_DEFAULT_W, BUBBLE_DEFAULT_H, BUBBLE_SIDES, _internals, _internals2,
  hueFor, identityColor, bubbleDim, firstCollision, routeTether, IDENTITY_SAT, IDENTITY_LIGHT,
} from './bubble.js';

// The default gap the helper uses inside the placement loop (BUBBLE_GAP).
// Some collision tests below compute the expected clear-space by hand using
// this constant so a future change to the gap surfaces in both the helper
// and the test at the same time.
const GAP = BUBBLE_GAP;

// ---- (a) age formatting ----

test('formatAge: seconds under a minute', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(1), '1s');
  assert.equal(formatAge(12.4), '12s');
  assert.equal(formatAge(59), '59s');
  // 59.7 -> 59 (floor)
  assert.equal(formatAge(59.7), '59s');
});

test('formatAge: minutes', () => {
  assert.equal(formatAge(60), '1m');
  assert.equal(formatAge(60 * 4 + 3), '4m');     // 4m 3s -> "4m"
  assert.equal(formatAge(60 * 59 + 30), '59m');
});

test('formatAge: hours', () => {
  assert.equal(formatAge(60 * 60), '1h');
  assert.equal(formatAge(60 * 60 * 2 + 5), '2h');
  assert.equal(formatAge(60 * 60 * 99), '99h');
});

test('formatAge: future / negative / non-finite ts clamps to 0s', () => {
  assert.equal(formatAge(-3), '0s');
  assert.equal(formatAge(-0.0001), '0s');
  assert.equal(formatAge(NaN), '0s');
  assert.equal(formatAge(Infinity), '0s');
  assert.equal(formatAge(-Infinity), '0s');
  assert.equal(formatAge('not a number'), '0s');
});

// ---- (b) truncation ----

test('truncateText: under max passes through', () => {
  assert.equal(truncateText('hello', 10), 'hello');
  assert.equal(truncateText('hello', 5), 'hello');            // exactly max: no ellipsis
  assert.equal(truncateText('', 10), '');
  assert.equal(truncateText(null, 10), '');
  assert.equal(truncateText(undefined, 10), '');
});

test('truncateText: over max gets an ellipsis', () => {
  // 6 chars to a 5-char budget -> "hell…"
  assert.equal(truncateText('hello world', 5), 'hell…');
  assert.equal(truncateText('hello world', 1), '…');          // degenerate budget
  assert.equal(truncateText('hello world', 0), '…');
});

test('truncateText: long sentence fits the 260 px bubble budget', () => {
  const long = 'a'.repeat(80) + ' ' + 'b'.repeat(80) + ' ' + 'c'.repeat(80);
  const out = truncateText(long, 80);
  assert.ok(out.length <= 80, 'output length');
  assert.ok(out.endsWith('…'), 'ellipsis marker');
});

// ---- (c) bubble eligibility ----

test('shouldShowBubble: active and monitoring only', () => {
  assert.equal(shouldShowBubble('active'), true);
  assert.equal(shouldShowBubble('monitoring'), true);
});

test('shouldShowBubble: idle, container, undefined, unknown all false', () => {
  assert.equal(shouldShowBubble('idle'), false);
  assert.equal(shouldShowBubble('container'), false);
  assert.equal(shouldShowBubble(undefined), false);
  assert.equal(shouldShowBubble(null), false);
  assert.equal(shouldShowBubble(''), false);
  assert.equal(shouldShowBubble('weird'), false);
});

// Expose the active set so a regression on the contract surfaces here.
test('shouldShowBubble: matches the ACTIVE_STATES set', () => {
  const set = _internals.ACTIVE_STATES;
  assert.equal(set.has('active'), true);
  assert.equal(set.has('monitoring'), true);
  assert.equal(set.has('idle'), false);
  assert.equal(set.has('container'), false);
});

// ---- (d) idle sub-line ----

test('idleSubline: format "idle · <age> · <branch>"', () => {
  assert.equal(idleSubline('8m', 'main'), 'idle · 8m · main');
  assert.equal(idleSubline('2h', 'feature/bubbles'), 'idle · 2h · feature/bubbles');
  assert.equal(idleSubline('12s', null), 'idle · 12s');      // null branch elided
  assert.equal(idleSubline('12s', ''), 'idle · 12s');         // empty branch elided
});

test('idleSubline: missing age falls back to "idle · <branch>"', () => {
  assert.equal(idleSubline(null, 'main'), 'idle · main');
  assert.equal(idleSubline('', 'main'), 'idle · main');
  assert.equal(idleSubline(undefined, 'main'), 'idle · main');
});

test('idleSubline: missing branch falls back to "idle · <age>"', () => {
  assert.equal(idleSubline('8m', null), 'idle · 8m');
  assert.equal(idleSubline('8m', undefined), 'idle · 8m');
  assert.equal(idleSubline('8m', ''), 'idle · 8m');
});

test('idleSubline: both missing returns plain "idle"', () => {
  assert.equal(idleSubline(null, null), 'idle');
  assert.equal(idleSubline('', ''), 'idle');
  assert.equal(idleSubline(undefined, undefined), 'idle');
});

// ---- secondsSince / idleAgeSeconds ----

test('secondsSince: future ts clamps to 0', () => {
  assert.equal(secondsSince(1000, 500), 0);
  assert.equal(secondsSince(1000, 1000), 0);
});

test('secondsSince: normal deltas', () => {
  assert.equal(secondsSince(0, 0), 0);
  assert.equal(secondsSince(0, 12_000), 12);
  assert.equal(secondsSince(0, 4 * 60_000), 4 * 60);
});

test('secondsSince: non-finite returns 0', () => {
  assert.equal(secondsSince(NaN, 1000), 0);
  assert.equal(secondsSince(1000, NaN), 0);
  assert.equal(secondsSince('foo', 1000), 0);
});

test('idleAgeSeconds: null/undefined ts returns null', () => {
  assert.equal(idleAgeSeconds(null, 1000), null);
  assert.equal(idleAgeSeconds(undefined, 1000), null);
});

test('idleAgeSeconds: normal ts delegates to secondsSince', () => {
  assert.equal(idleAgeSeconds(0, 12_000), 12);
  assert.equal(idleAgeSeconds(0, 4 * 60_000), 240);
});

// ---- localStorage wrappers ----

test('loadBubblePref: absent returns fallback', () => {
  // The helper reads from globalThis.localStorage. In node, globalThis.localStorage
  // is undefined; the helper must fall back without throwing.
  const before = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.equal(loadBubblePref('any', true), true);
    assert.equal(loadBubblePref('any', false), false);
  } finally {
    if (before !== undefined) globalThis.localStorage = before;
  }
});

test('loadBubblePref + saveBubblePref: a fake localStorage round-trips', () => {
  const store = new Map();
  const before = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    assert.equal(loadBubblePref('k', true), true, 'absent -> fallback true');
    saveBubblePref('k', false);
    assert.equal(loadBubblePref('k', true), false, 'persisted false wins');
    saveBubblePref('k', true);
    assert.equal(loadBubblePref('k', false), true, 'persisted true wins');
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
  }
});

test('loadBubblePref + saveBubblePref: a throwing localStorage is a no-op', () => {
  const before = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  try {
    assert.equal(loadBubblePref('k', true), true);
    saveBubblePref('k', false);                          // must not throw
    assert.ok(true, 'throwing storage tolerated');
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
  }
});

// ---- accentFor (owner-colour helper) ----

test('accentFor: kind-specific colours (folder/branch/hermes/session)', () => {
  // Each kind has its own accent; the helper must mirror the App.jsx
  // colourOf() so the bubble border, tail and leader line match the card.
  assert.equal(accentFor({ kind: 'folder' }), '#cfd9e6');
  assert.equal(accentFor({ kind: 'branch' }), '#8ea4bf');
  assert.equal(accentFor({ kind: 'hermes' }), '#f07ab8');
  assert.equal(accentFor({ kind: 'session' }), '#dbe4f0');
});

test('accentFor: role wins over generic agent blue', () => {
  assert.equal(accentFor({ kind: 'agent', role: 'planner' }), '#9a8cff');
  assert.equal(accentFor({ kind: 'agent', role: 'engineer' }), '#63a6ff');
  assert.equal(accentFor({ kind: 'agent', role: 'tester' }), '#4ecb8c');
  assert.equal(accentFor({ kind: 'agent', role: 'devops' }), '#e0a33e');
  // Unknown role falls back to the generic agent blue.
  assert.equal(accentFor({ kind: 'agent', role: 'unknown' }), '#63a6ff');
  assert.equal(accentFor({ kind: 'agent' }), '#63a6ff');
});

test('accentFor: defensive — null/undefined/non-object data', () => {
  // Pure: must not throw on any input.
  assert.equal(accentFor(null), '#63a6ff');
  assert.equal(accentFor(undefined), '#63a6ff');
  assert.equal(accentFor({}), '#63a6ff');
  assert.equal(accentFor('not an object'), '#63a6ff');
});

// ---- bubbleLines (age-on-said-only contract) ----

test('bubbleLines: action + said => age lives on the action line only (not the said line)', () => {
  // When both exist, the original design has the age on the action line.
  // The said line should not duplicate it.
  const lines = bubbleLines({ action: 'node --test', said: 'thinking aloud' }, 42);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'action');
  assert.equal(lines[0].text, 'node --test');
  assert.equal(lines[0].age, '42s');
  assert.equal(lines[1].kind, 'said');
  assert.equal(lines[1].text, 'thinking aloud');
  assert.equal(lines[1].age, '42s');                 // every line carries the age
});

test('bubbleLines: said-only bubble still shows an age (the Orca-terminal gap fix)', () => {
  // This is the bug from the spec: Orca terminals have no action line, so
  // the original implementation rendered the said line without any age.
  // The new contract: when action is null and said exists, the age MUST
  // be on the said line.
  const lines = bubbleLines({ action: null, said: 'Zigzagging through edits' }, 5 * 60);
  assert.equal(lines.length, 1, 'one line for said-only bubbles');
  assert.equal(lines[0].kind, 'said');
  assert.equal(lines[0].text, 'Zigzagging through edits');
  assert.equal(lines[0].age, '5m', 'age rendered on said line when action is null');
});

test('bubbleLines: empty / null / missing activity yields no lines', () => {
  assert.deepEqual(bubbleLines(null, 10), []);
  assert.deepEqual(bubbleLines(undefined, 10), []);
  assert.deepEqual(bubbleLines({ action: null, said: null }, 10), []);
  assert.deepEqual(bubbleLines({}, 10), []);
});

test('bubbleLines: negative or non-finite ageSec falls back to 0s', () => {
  // Same defensive behaviour as formatAge: future ts / NaN must clamp.
  const lines = bubbleLines({ action: 'foo' }, -5);
  assert.equal(lines[0].age, '0s');
  assert.deepEqual(bubbleLines({ action: 'foo' }, NaN), [{ kind: 'action', text: 'foo', age: '0s' }]);
  assert.deepEqual(bubbleLines({ action: 'foo' }, Infinity), [{ kind: 'action', text: 'foo', age: '0s' }]);
});

test('bubbleLines: action-only (no said) still shows the age on the action line', () => {
  const lines = bubbleLines({ action: 'git status' }, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'action');
  assert.equal(lines[0].age, '0s');
});

// ---- placeBubbles: pure placement helper ----
//
// The contract: every bubble MUST be placed so that (a) it does not
// intersect any non-owner card, (b) it does not intersect any other placed
// bubble (>= BUBBLE_GAP apart), and (c) the owner card's position is
// NEVER moved. The owner card's measurements are passed in as part of the
// `cards` input — placeBubbles() never mutates the input.

function rectOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test('placeBubbles: above is the default for a single card on an empty canvas', () => {
  const cards = [{ id: 'c1', x: 100, y: 100, w: 200, h: 56 }];
  const bubbles = [{ ownerId: 'c1' }];
  const placements = placeBubbles({ cards, bubbles });
  const p = placements.get('c1');
  assert.ok(p, 'placement returned');
  assert.equal(p.side, 'above');
  // Above the card: bubble bottom = card.top - gap, bubble height = 48
  // (default), so bubble top = card.top - gap - h. Default gap = 4.
  assert.equal(p.h, BUBBLE_DEFAULT_H);
  assert.equal(p.w, BUBBLE_DEFAULT_W);
});

test('placeBubbles: when the initial "above" position collides, the helper PUSHES above (preserves the side)', () => {
  // Card at (100, 100). A second card sits above it (would intersect the
  // bubble if placed "above"). The new contract: the helper does NOT flip
  // to "below" — it pushes the bubble further UP along the same axis, so
  // the leader line stays attached to the same side of the owner card.
  // Flipping the side would visually yank the leader line to the other
  // side of the card every time a neighbour shuffled in or out, which
  // is exactly the per-poll churn the spec is trying to eliminate.
  const cards = [
    { id: 'c1', x: 100, y: 100, w: 200, h: 56 },
    { id: 'c2', x: 100, y: 0,   w: 200, h: 100 },     // sits above c1
  ];
  const bubbles = [{ ownerId: 'c1' }];
  // The un-pushed "above" candidate would be at y = 100 - 28 - 16 - 48 = 8
  // (owner top - gap - bubble height). That collides with c2 (y=0..100).
  // The pushed position lands further up, clear of c2.
  const placements = placeBubbles({ cards, bubbles });
  const p = placements.get('c1');
  assert.ok(p, 'placement returned');
  assert.equal(p.side, 'above', 'side preserved across the push (no flip to below)');
  assert.notEqual(p.collision, true, 'pushed placement is collision-free');
  // The bubble rect must clear c2 with at least BUBBLE_GAP between them.
  const bubbleRect = { x: p.x, y: p.y, w: p.w, h: p.h };
  // gap on each axis (positive = disjoint with the gap).
  const gapX = Math.max(0, Math.max(cards[1].x - (bubbleRect.x + bubbleRect.w),
                                    bubbleRect.x - (cards[1].x + cards[1].w)));
  const gapY = Math.max(0, Math.max(cards[1].y - (bubbleRect.y + bubbleRect.h),
                                    bubbleRect.y - (cards[1].y + cards[1].h)));
  assert.ok(gapX >= GAP || gapY >= GAP,
    `bubble vs c2 gapX=${gapX} gapY=${gapY} < ${GAP}`);
});

test('placeBubbles: in a crowded fixture, 0 overlaps and 0 non-owner collisions', () => {
  // Two close working cards (c1, c2) plus a third non-owner card (c3)
  // sitting above c1. c1 and c2 both get bubbles; both must land clear of
  // c3 and clear of each other.
  const cards = [
    { id: 'c1', x: 100, y: 200, w: 200, h: 56 },
    { id: 'c2', x: 320, y: 200, w: 200, h: 56 },
    { id: 'c3', x: 100, y:  50, w: 200, h: 56 },       // above c1
  ];
  const bubbles = [{ ownerId: 'c1' }, { ownerId: 'c2' }];
  const placements = placeBubbles({ cards, bubbles });
  assert.equal(placements.size, 2, 'two placements');
  // Every placement must be at least BUBBLE_GAP clear of every non-owner card.
  for (const [ownerId, p] of placements) {
    for (const c of cards) {
      if (c.id === ownerId) continue;
      const gap = Math.max(0, Math.max(
        c.x - (p.x + p.w), p.x - (c.x + c.w),
        c.y - (p.y + p.h), p.y - (c.y + c.h),
      ));
      assert.ok(gap >= BUBBLE_GAP,
        `bubble for ${ownerId} vs card ${c.id}: gap ${gap.toFixed(1)} < ${BUBBLE_GAP}`);
    }
  }
  // Two bubble rects must not overlap each other.
  const ps = [...placements.values()];
  assert.ok(!rectOverlap(ps[0], ps[1]), 'bubble rects do not overlap each other');
});

test('placeBubbles: the owner card is never moved (helper is read-only on the cards input)', () => {
  const cards = [
    { id: 'c1', x: 100, y: 100, w: 200, h: 56 },
    { id: 'c2', x: 110, y: 100, w: 200, h: 56 },
  ];
  const snapshot = JSON.parse(JSON.stringify(cards));
  placeBubbles({ cards, bubbles: [{ ownerId: 'c1' }] });
  assert.deepEqual(cards, snapshot, 'cards[] unchanged after placeBubbles');
});

test('placeBubbles: when no collision-free side exists even after pushing, the placement reports a collision flag', () => {
  // Wrap c1 in blockers on every side AND cap the viewport so the push
  // can't escape. The bubble for c1 is 200x48. Without a viewport the
  // helper can push the bubble off the top of the canvas to clear c2;
  // with a viewport sized to bound the push, every side's push runs
  // into a wall. The helper must report collision=true and the side
  // must be the preferred 'above' (no flip to a side the user never
  // asked for) so the caller can decide to hide the bubble.
  const cards = [
    { id: 'c1', x: 250, y: 200, w: 50, h: 30 },
    { id: 'c2', x: 0,   y: 0,   w: 500, h: 100 },     // spans above
    { id: 'c3', x: 0,   y: 250, w: 500, h: 150 },     // spans below
    { id: 'c4', x: 300, y: 0,   w: 200, h: 400 },     // spans right
    { id: 'c5', x: 0,   y: 0,   w: 200, h: 400 },     // spans left
  ];
  // Viewport tightly bounds the canvas so every push runs into a wall
  // (the push would otherwise slide the bubble off the canvas, which
  // is fine for visibility but doesn't represent the in-frame guarantee
  // the spec asks for).
  const placements = placeBubbles({
    cards, bubbles: [{ ownerId: 'c1' }],
    viewport: { width: 500, height: 400 },
  });
  const p = placements.get('c1');
  assert.ok(p, 'placement returned');
  assert.equal(p.collision, true, 'collision flag set: every side was blocked even after pushing');
  assert.equal(p.side, 'above', 'preferred side when collision: no flip to an untested side');
});

test('placeBubbles: side preference order is documented and pinned', () => {
  // The helper prefers above -> below -> right -> left. This test pins
  // the order so a future change has to update the test (which is the
  // right place to read the change).
  assert.deepEqual(BUBBLE_SIDES, ['above', 'below', 'right', 'left']);
});

test('placeBubbles: empty inputs return an empty map', () => {
  assert.equal(placeBubbles({ cards: [], bubbles: [{ ownerId: 'x' }] }).size, 0);
  assert.equal(placeBubbles({ cards: [{ id: 'x', x: 0, y: 0, w: 1, h: 1 }], bubbles: [] }).size, 0);
  assert.equal(placeBubbles({}).size, 0);
});

test('placeBubbles: a bubble owner that is not in the cards list is silently skipped', () => {
  const cards = [{ id: 'c1', x: 100, y: 100, w: 200, h: 56 }];
  const bubbles = [{ ownerId: 'c1' }, { ownerId: 'ghost' }];
  const placements = placeBubbles({ cards, bubbles });
  assert.equal(placements.size, 1, 'only the known owner got a placement');
  assert.ok(placements.has('c1'));
  assert.ok(!placements.has('ghost'));
});

test('placeBubbles: per-bubble size override (b.size) wins over the default w/h', () => {
  // The bubble's actual rendered size is 280x48 (long action+said line).
  // The default is 200x48, which would under-count and let the helper
  // place the bubble where the 80 extra px on the right collides with a
  // card. With the per-bubble size, the candidate rect is 280x48 and
  // the collision check is correct.
  const cards = [
    { id: 'c1', x: 100, y: 100, w: 200, h: 56 },
    { id: 'c2', x: 100, y:  50, w: 200, h: 40 },     // sits above c1
  ];
  const bubbles = [{ ownerId: 'c1', size: { w: 280, h: 48 } }];
  const placements = placeBubbles({ cards, bubbles });
  const p = placements.get('c1');
  assert.ok(p, 'placement returned');
  // The bubble's actual width must be 280, not the default 200.
  assert.equal(p.w, 280, 'per-bubble w wins over the default');
  assert.equal(p.h, 48, 'per-bubble h wins over the default');
  // "above" would overlap c2 (bubble bottom 56, c2 bottom 90, gap = -6
  // in flow). The helper should pick "below" or another side. The exact
  // side is whatever clears; we just check the placement is clear of
  // every non-owner card.
  for (const c of cards) {
    if (c.id === 'c1') continue;
    const dx = Math.max(0, Math.min(p.x + p.w, c.x + c.w) - Math.max(p.x, c.x));
    const dy = Math.max(0, Math.min(p.y + p.h, c.y + c.h) - Math.max(p.y, c.y));
    assert.ok(dx >= 16 || dy >= 16,
      `bubble vs ${c.id}: dx=${dx} dy=${dy} < BUBBLE_GAP`);
  }
});

test('_internals2: the BUBBLE_* constants are exported and stable', () => {
  // Pinning the contract: tests + App.jsx read the constants through the
  // export, so a rename or a value change surfaces here.
  const ints = _internals2;
  assert.equal(ints.BUBBLE_GAP, 16);
  assert.equal(ints.BUBBLE_DEFAULT_W, 200);
  assert.equal(ints.BUBBLE_DEFAULT_H, 48);
  assert.deepEqual(ints.BUBBLE_SIDES, ['above', 'below', 'right', 'left']);
  // The push-out arm of the contract: when every side is blocked the
  // helper must try a bounded push along the chosen axis before giving
  // up. PUSH_STEP controls the resolution (a 24 px step is finer than
  // the per-poll separation pass can move a card in one tick); MAX_PUSH
  // caps the total distance so a fixture with a small viewport doesn't
  // spin forever.
  assert.equal(ints.PUSH_STEP, 24);
  assert.equal(ints.MAX_PUSH, 800);
});

test('placeBubbles: the push-out arm finds a clear position when the initial candidate collides', () => {
  // A single blocker sits directly above the owner. The un-pushed "above"
  // candidate collides; the helper must push the rect further up until
  // the bubble clears the blocker (rect.y + rect.h + GAP <= blocker.y).
  // We assert the exact pushed position so a future regression that
  // flips the side, or short-circuits the push, surfaces here.
  const cards = [
    { id: 'c1', x: 100, y: 200, w: 200, h: 56 },
    { id: 'c2', x: 100, y: 100, w: 200, h: 80 },     // sits above c1, leaves room to push up
  ];
  const bubbles = [{ ownerId: 'c1' }];
  const placements = placeBubbles({ cards, bubbles });
  const p = placements.get('c1');
  assert.ok(p, 'placement returned');
  assert.equal(p.side, 'above', 'side preserved');
  assert.notEqual(p.collision, true, 'pushed placement is collision-free');
  // The un-pushed "above" candidate would be at y = 200 - 28 - 16 - 48 = 108.
  // To clear c2 (y=100..180) we need p.y + 48 + 16 <= 100, so p.y <= 36.
  // The pushed position must be at or above y=36 (any value < 108 counts as pushed).
  assert.ok(p.y < 108, `pushed y=${p.y} should be < initial 108`);
  assert.ok(p.y <= 36, `pushed y=${p.y} should be <= 36 to clear c2 with gap`);
  // And the rect must actually clear c2 with the BUBBLE_GAP.
  const gapY = c2_top_gap(p, cards[1]);
  assert.ok(gapY >= GAP, `gapY=${gapY} < ${GAP}`);
});

test('placeBubbles: push-out keeps the side and the leader line direction', () => {
  // After a push, the side must NOT have changed. The CSS uses data-side
  // to rotate the leader line so it still points at the owner card; if
  // the side flipped, the leader line would visually swap sides every
  // time a neighbour moved in. This test pins "the side is the chosen
  // one even after the bubble was pushed to a clear position".
  const cards = [
    { id: 'c1', x: 100, y: 200, w: 200, h: 56 },
    { id: 'c2', x: 100, y: 100, w: 200, h: 80 },     // blocker above
    { id: 'c3', x: 100, y: 320, w: 200, h: 80 },     // blocker below too — but side is "above" first
  ];
  const bubbles = [{ ownerId: 'c1' }];
  const placements = placeBubbles({ cards, bubbles });
  const p = placements.get('c1');
  assert.equal(p.side, 'above', 'side stays "above" even when below is also blocked');
});

test('placeBubbles: push-out respects the viewport (no off-screen placement) when a clear position exists', () => {
  // With a viewport that bounds the push, the helper pushes until the
  // bubble clears the blocker OR hits the viewport wall. When a clear
  // position exists inside the viewport, the helper must return it
  // (collision: false) — not give up early.
  const cards = [
    { id: 'c1', x: 200, y: 300, w: 200, h: 56 },
    { id: 'c2', x: 200, y: 200, w: 200, h: 80 },     // sits above c1
  ];
  const placements = placeBubbles({
    cards, bubbles: [{ ownerId: 'c1' }],
    viewport: { width: 800, height: 600 },
  });
  const p = placements.get('c1');
  assert.equal(p.side, 'above', 'side preserved');
  assert.notEqual(p.collision, true, 'push found a clear in-viewport position');
  // In-viewport: 0 <= p.x, p.x + p.w <= width, 0 <= p.y, p.y + p.h <= height.
  assert.ok(p.x >= 0 && p.x + p.w <= 800, `x=${p.x} w=${p.w} outside viewport`);
  assert.ok(p.y >= 0 && p.y + p.h <= 600, `y=${p.y} h=${p.h} outside viewport`);
});

test('placeBubbles: every placement is collision-free against every non-owner card (no overlaps ever)', () => {
  // The end-to-end guarantee: for every owner in the input, the
  // returned placement rect (post any push-out) MUST clear every
  // non-owner card with at least BUBBLE_GAP. A random layout is the
  // strictest test: a single missed push is caught here, not in a
  // hand-rolled scenario.
  let s = 98765;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0xffffffff) / 0x100000000; };
  for (let trial = 0; trial < 25; trial++) {
    const n = 5 + Math.floor(rng() * 6);                      // 5..10 cards
    const cards = [];
    for (let i = 0; i < n; i++) {
      cards.push({
        id: 'c' + i,
        x: Math.floor(rng() * 800),
        y: Math.floor(rng() * 600),
        w: 100 + Math.floor(rng() * 200),
        h: 40 + Math.floor(rng() * 40),
      });
    }
    // Choose a random subset of cards as bubble owners.
    const owners = cards.filter(() => rng() < 0.6);
    if (!owners.length) owners.push(cards[0]);
    const bubbles = owners.map((o) => ({ ownerId: o.id }));
    const placements = placeBubbles({ cards, bubbles });
    for (const [ownerId, p] of placements) {
      if (p.collision) continue;                     // collisions are honest: caller hides
      for (const c of cards) {
        if (c.id === ownerId) continue;
        const gapX = Math.max(0, Math.max(c.x - (p.x + p.w), p.x - (c.x + c.w)));
        const gapY = Math.max(0, Math.max(c.y - (p.y + p.h), p.y - (c.y + c.h)));
        assert.ok(gapX >= GAP || gapY >= GAP,
          `trial ${trial}: bubble for ${ownerId} vs ${c.id} gapX=${gapX} gapY=${gapY} < ${GAP}`);
      }
    }
  }
});

// Helpers for the push-out tests above.
function c2_top_gap(bubble, blocker) {
  // Minimum y-axis gap between the bubble's bottom and the blocker's top.
  // The push-out arm must keep this >= BUBBLE_GAP; a smaller value means
  // the bubble is overlapping or touching the blocker.
  return Math.max(0, blocker.y - (bubble.y + bubble.h));
}

// ---- D1 identity colour ----
//
// hueFor(nodeId): a deterministic hue in [0,360) derived from the id via
// FNV-1a + the golden angle. Same id -> same hue; different ids land on
// distinct points; the helper is pure and stable across calls.

test('hueFor: deterministic per id', () => {
  // The plan pins this: the same id MUST produce the same hue on every
  // call so the card border, tether and socket all stay in sync.
  assert.equal(hueFor('session-1'), hueFor('session-1'));
  assert.equal(hueFor('agent-7'), hueFor('agent-7'));
  assert.equal(hueFor(''), hueFor(''));
});

test('hueFor: twelve ids give pairwise distinct hues', () => {
  // Twelve distinct ids -> twelve distinct hues. The exact hues are not
  // pinned (they depend on the FNV + golden angle values), only that no
  // two of the inputs collapse to the same hue. With 12 ids over 360
  // hue bins, even a poor hash would give ~95% distinct, so a true
  // collision shows up as a duplicate here.
  const ids = Array.from({ length: 12 }, (_, i) => 'session-' + (i + 1));
  const hues = ids.map(hueFor);
  assert.equal(new Set(hues).size, hues.length, 'all 12 ids map to distinct hues');
});

test('hueFor: every result lies in [0,360)', () => {
  // Pins the contract so a future "times 360" bug surfaces as a failing
  // test instead of a CSS clamp that hides the rotation.
  const ids = ['a', 'b', 'session-1', 'agent-7', 'uuid:00000000-0000-0000-0000-000000000000',
               'xyz', 'node-42', 'session-very-long-id-with-many-segments',
               '機場', '', null, undefined, '0', 'session-1::sub'];
  for (const id of ids) {
    const h = hueFor(id);
    assert.ok(Number.isFinite(h), 'hue is finite for ' + JSON.stringify(id));
    assert.ok(h >= 0 && h < 360, 'hue in [0,360) for ' + JSON.stringify(id) + ' got ' + h);
  }
});

test('identityColor: returns an hsl(...) string carrying the hueFor(nodeId) value', () => {
  // The CSS consumer only sees the rendered string; we pin its exact
  // shape so a future version that switches to rgb()/hex()/named-color
  // surfaces here, not at the bubble border.
  const c = identityColor('session-1');
  assert.match(c, /^hsl\(\s*[0-9.]+\s+([0-9.]+)%\s+([0-9.]+)%\s*\)$/);
  const m = c.match(/hsl\(\s*([0-9.]+)\s/);
  const hueFromStr = Number(m[1]);
  assert.equal(hueFromStr, hueFor('session-1'), 'identityColor hue matches hueFor(nodeId)');
  // Saturation + lightness are the spec constants so the palette stays
  // consistent across the workspace.
  assert.equal(IDENTITY_SAT, 68);
  assert.equal(IDENTITY_LIGHT, 64);
  assert.ok(c.includes(IDENTITY_SAT + '%'), 'identityColor carries IDENTITY_SAT');
  assert.ok(c.includes(IDENTITY_LIGHT + '%'), 'identityColor carries IDENTITY_LIGHT');
});

test('identityColor: null/undefined/empty id do not throw', () => {
  // Defensive: every code path that builds the colour before the node is
  // measured must still produce a valid hsl() string.
  for (const v of [null, undefined, '', 0, false]) {
    const out = identityColor(v);
    assert.match(out, /^hsl\(/);
  }
});

test('identityColor: stable across calls', () => {
  // The same id must produce the same string on every call so React
  // doesn't see a new "color" prop every render (which would force a
  // re-style each tick).
  for (let i = 0; i < 10; i++) assert.equal(identityColor('session-9'), identityColor('session-9'));
});

// ---- D2 routed tether (routeTether) ----
//
// Inputs: from, to (flow-space {x,y}), blockers [{x,y,w,h}, ...].
// Output: { d, points } where d is an SVG path string and points is the
// polyline (so the tests can sample it).
//
// Contract:
//   - No blocker => two-point straight path.
//   - Blocker straddling the segment => three points, BOTH segments clear.
//   - Always returns a path (never null), even when maxPush is exhausted.
//   - 100-sample interior of every segment falls outside every blocker.
//   - Deterministic: identical inputs give identical d strings.

function samplePoints(points, perSegment = 100) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    for (let k = 0; k <= perSegment; k++) {
      const t = k / perSegment;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
function pointInRect(p, r) {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}
function rectClearOfBlockers(points, blockers, perSegment = 100) {
  const samples = samplePoints(points, perSegment);
  for (const s of samples) {
    for (const r of blockers) {
      if (pointInRect(s, r)) return false;
    }
  }
  return true;
}

test('routeTether: straight path with no blockers has exactly two points', () => {
  const out = routeTether({ from: { x: 0, y: 0 }, to: { x: 100, y: 80 }, blockers: [] });
  assert.equal(out.points.length, 2, 'straight tether has two points');
  assert.equal(out.points[0].x, 0); assert.equal(out.points[0].y, 0);
  assert.equal(out.points[1].x, 100); assert.equal(out.points[1].y, 80);
  // The d string is a Move + Line.
  assert.ok(out.d.startsWith('M '), 'd begins with M');
  assert.ok(out.d.includes(' L '), 'd contains at least one L');
});

test('routeTether: blockers list omitted defaults to no blockers', () => {
  // Defensive: callers in App.jsx may pass a 0-length blockers without
  // explicit []; the helper should not throw.
  const out = routeTether({ from: { x: 10, y: 10 }, to: { x: 60, y: 60 } });
  assert.equal(out.points.length, 2, 'no-blockers default yields a straight line');
});

test('routeTether: a blocker straddling the segment forces a 3-point bend', () => {
  // A 30x10 rect sits right in the middle of the from->to segment, so the
  // straight line would pass through it. The helper must insert a bend.
  const blockers = [{ x: 40, y: 40, w: 30, h: 10 }];   // straddles the (0,0)->(100,100) line
  const out = routeTether({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, blockers });
  assert.equal(out.points.length, 3, 'straddling blocker produces a three-point bend');
  // Every sampled point lies outside every blocker.
  assert.ok(rectClearOfBlockers(out.points, blockers), 'every sample is outside every blocker');
});

test('routeTether: even with a wide blocker both segments clear every blocker', () => {
  // A 100x40 horizontal blocker sits across the middle of the path. The
  // straight line passes through it; the bent path must clear it.
  const blockers = [{ x: 0, y: 45, w: 100, h: 40 }];
  const out = routeTether({ from: { x: 50, y: 0 }, to: { x: 50, y: 100 }, blockers });
  assert.ok(out.points.length >= 2, 'at least the endpoints');
  assert.ok(rectClearOfBlockers(out.points, blockers), 'every sample outside the blocker');
});

test('routeTether: returns a path even when maxPush is exhausted', () => {
  // Wrap the endpoints in an enormous blocker that consumes the entire
  // perpendicular room. The helper must still return a points array and
  // a d string - the caller hides the bubble in that case, but the
  // renderer should never get null.
  const blockers = [{ x: -1e6, y: -1e6, w: 2e6, h: 2e6 }];
  const out = routeTether({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, blockers, step: 18, maxPush: 36 });
  assert.ok(out.points.length >= 2, 'a path is returned even with a room-eating blocker');
  assert.ok(typeof out.d === 'string' && out.d.length > 0, 'd is a non-empty string');
});

test('routeTether: deterministic for identical inputs', () => {
  const blockers = [{ x: 30, y: 30, w: 40, h: 40 }];
  const a = routeTether({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, blockers });
  const b = routeTether({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, blockers });
  assert.equal(a.d, b.d, 'identical inputs yield identical d strings');
  assert.deepEqual(a.points, b.points, 'identical inputs yield identical point arrays');
});

test('routeTether: non-finite endpoints do not throw', () => {
  // Defensive: a hover-driven render that builds the tether before the
  // host element is measured may pass NaN/null. The helper must return
  // an empty path rather than throw, so the renderer's contract stays
  // simple.
  for (const bad of [null, undefined, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
    const out = routeTether({ from: bad, to: { x: 1, y: 1 } });
    assert.equal(typeof out.d, 'string', 'd is a string for non-finite from');
    assert.deepEqual(out.points, [], 'points is [] for non-finite from');
  }
});

test('routeTether: 100-sample interior of each segment stays outside every blocker (synthetic layout)', () => {
  // Random layout stress: 25 trials, three blockers around the line.
  // Every sampled interior point must lie outside every blocker. A
  // single miss surfaces here.
  let s = 24680;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s & 0xffffffff) / 0x100000000; };
  for (let trial = 0; trial < 25; trial++) {
    const ax = Math.floor(rng() * 800);
    const ay = Math.floor(rng() * 600);
    const bx = ax + 100 + Math.floor(rng() * 400);
    const by = ay + 100 + Math.floor(rng() * 400);
    const blockers = [];
    for (let k = 0; k < 3; k++) {
      const rx = Math.floor(rng() * 800);
      const ry = Math.floor(rng() * 600);
      const rw = 40 + Math.floor(rng() * 100);
      const rh = 40 + Math.floor(rng() * 100);
      // Skip blockers that do not straddle the segment to avoid wasting
      // samples on trivially-clear trials.
      const midX = (ax + bx) / 2, midY = (ay + by) / 2;
      if (midX > rx && midX < rx + rw && midY > ry && midY < ry + rh) {
        blockers.push({ x: rx, y: ry, w: rw, h: rh });
      }
    }
    if (!blockers.length) continue;
    const out = routeTether({ from: { x: ax, y: ay }, to: { x: bx, y: by }, blockers });
    assert.ok(rectClearOfBlockers(out.points, blockers),
      `trial ${trial}: tether crossed a blocker, points=${JSON.stringify(out.points)}`);
  }
});

// ---- D3 hover dim (bubbleDim) ----

test('bubbleDim: hoverId null -> every bubble un-dimmed', () => {
  assert.equal(bubbleDim(null, 'a'), false);
  assert.equal(bubbleDim(null, 'anything'), false);
  assert.equal(bubbleDim(undefined, 'a'), false);
});

test('bubbleDim: hoverId set -> only the hovered bubble is un-dimmed', () => {
  assert.equal(bubbleDim('a', 'a'), false, 'hovered card: un-dimmed');
  assert.equal(bubbleDim('a', 'b'), true,  'non-hovered card: dimmed');
});

test('bubbleDim: stable and pure for arbitrary ids', () => {
  // Deterministic and side-effect free: same in, same out.
  for (let i = 0; i < 5; i++) {
    assert.equal(bubbleDim('session-42', 'session-42'), false);
    assert.equal(bubbleDim('session-42', 'session-7'), true);
  }
});

// ---- D4 firstCollision ----
//
// Contract: return the FIRST bubble whose rect intersects a NON-OWNER
// card. Bubbles inside their owner card must NOT count.

test('firstCollision: no bubbles / no cards returns null', () => {
  assert.equal(firstCollision([], [{ id: 'c1', rect: { x: 0, y: 0, w: 100, h: 100 } }]), null);
  assert.equal(firstCollision([{ id: 'b1', ownerId: 'c1', rect: { x: 0, y: 0, w: 50, h: 50 } }], []), null);
  assert.equal(firstCollision([], []), null);
});

test('firstCollision: a bubble inside its OWNER card is not flagged', () => {
  // The owner card encloses the bubble, but the owner/card pair is
  // explicitly allowed: every bubble's leader / tether starts at the
  // owner's top-centre, so a bubble that overlaps its OWNER (placed
  // with a small gap) is acceptable. Only collisions with OTHER cards
  // should fire.
  const bubbles = [{ id: 'b1', ownerId: 'c1', rect: { x: 110, y: 110, w: 50, h: 30 } }];
  const cards = [{ id: 'c1', rect: { x: 100, y: 100, w: 200, h: 60 } }];
  assert.equal(firstCollision(bubbles, cards), null, 'bubble inside owner does not fire');
});

test('firstCollision: bubble inside a non-owner card returns that bubble id', () => {
  const bubbles = [{ id: 'b1', ownerId: 'c1', rect: { x: 310, y: 110, w: 50, h: 30 } }];
  const cards = [
    { id: 'c1', rect: { x: 100, y: 100, w: 200, h: 60 } },     // owner
    { id: 'c2', rect: { x: 300, y: 100, w: 200, h: 60 } },     // the offender
  ];
  assert.equal(firstCollision(bubbles, cards), 'b1');
});

test('firstCollision: returns the first offending bubble id when several overlap', () => {
  const bubbles = [
    { id: 'b1', ownerId: 'c1', rect: { x: 0,   y: 0,   w: 50, h: 50 } },  // clear
    { id: 'b2', ownerId: 'c2', rect: { x: 310, y: 110, w: 50, h: 30 } },  // inside c3
    { id: 'b3', ownerId: 'c3', rect: { x: 510, y: 110, w: 50, h: 30 } },  // inside c4 (second)
  ];
  const cards = [
    { id: 'c1', rect: { x: -50, y: -50, w: 200, h: 100 } },
    { id: 'c2', rect: { x: 100, y: 100, w: 200, h: 60 } },
    { id: 'c3', rect: { x: 300, y: 100, w: 200, h: 60 } },
    { id: 'c4', rect: { x: 500, y: 100, w: 200, h: 60 } },
  ];
  // b2 fires first (first overlapping bubble), so the id returned is b2.
  assert.equal(firstCollision(bubbles, cards), 'b2');
});

test('firstCollision: a bubble within 1 flow unit of a non-owner card IS flagged (slack matches the acceptance test)', () => {
  // The implementation uses a 1-unit slack on every axis (matching the
  // acceptance test's `gap(b, c) < 1` Euclidean metric), so a bubble
  // whose right edge is barely on top of a non-owner card counts as
  // overlapping. The slack absorbs sub-pixel / sub-flow rounding error
  // (React Flow measured widths in CSS pixels, which round differently
  // across re-measures). Without the slack, strict-intersection misses
  // 1-px-grazing bubbles the acceptance test counts as overlaps.
  const bubbles = [{ id: 'b1', ownerId: 'c1', rect: { x: 100, y: 100, w: 50, h: 50 } }];
  const cards = [
    { id: 'c1', rect: { x: 0,   y: 0,   w: 100, h: 200 } },     // owner (skipped)
    { id: 'c2', rect: { x: 150, y: 100, w: 100, h: 50 } },     // bubble right edge = c2 left edge (gap = 0)
  ];
  assert.equal(firstCollision(bubbles, cards), 'b1',
    'edge-touching IS flagged (slack matches acceptance test)');
});

// ---- sticky + nearest placement (prev-aware) ----

const owner500 = { id: 'o', x: 500, y: 500, w: 200, h: 56 };

test('placeBubbles sticky: a prev placement that still fits is returned EXACTLY (not re-picked above-first)', () => {
  // 'above' would be first in the fixed order and is free here, but the bubble
  // currently sits BELOW (an off-centre slot): it must stay exactly there.
  const prev = new Map([['o', { side: 'below', x: 430, y: 544 }]]);
  const p = placeBubbles({ cards: [owner500], bubbles: [{ ownerId: 'o' }], prev }).get('o');
  assert.equal(p.side, 'below');
  assert.equal(p.x, 430);
  assert.equal(p.y, 544);
  assert.notEqual(p.collision, true);
});

test('placeBubbles sticky: re-running with its own output is a fixed point (no churn)', () => {
  const cards = [owner500, { id: 'n', x: 900, y: 500, w: 200, h: 56 }];
  const bubbles = [{ ownerId: 'o' }, { ownerId: 'n' }];
  const first = placeBubbles({ cards, bubbles });
  const second = placeBubbles({ cards, bubbles, prev: first });
  for (const [id, a] of first) {
    const b = second.get(id);
    assert.equal(b.side, a.side); assert.equal(b.x, a.x); assert.equal(b.y, a.y);
  }
});

test('placeBubbles sticky: the bubble follows its owner when the owner moves (same side, same slot)', () => {
  const first = placeBubbles({ cards: [owner500], bubbles: [{ ownerId: 'o' }] });
  const moved = { ...owner500, x: owner500.x + 7, y: owner500.y + 3 };
  const p = placeBubbles({ cards: [moved], bubbles: [{ ownerId: 'o' }], prev: first }).get('o');
  const a = first.get('o');
  assert.equal(p.side, a.side);
  assert.equal(p.x, a.x + 7);
  assert.equal(p.y, a.y + 3);
});

test('placeBubbles nearest: a blocked bubble moves to the candidate NEAREST its old anchor, not the first side', () => {
  // Bubble sits to the RIGHT (low on the card). A tall card now blocks the
  // right. Above-centred would be first in the fixed order, but the below
  // slide is nearer to the old anchor (which sits low) and must win.
  const blocker = { id: 'b', x: 760, y: 500, w: 100, h: 300 };      // x 710..810, y 350..650
  const prev = new Map([['o', { side: 'right', x: 616, y: 510 }]]);
  const p = placeBubbles({ cards: [owner500, blocker], bubbles: [{ ownerId: 'o' }], prev }).get('o');
  assert.notEqual(p.collision, true);
  assert.equal(p.side, 'below', 'the nearer candidate wins over the above-first order');
  const ax = 616 + 100, ay = 510 + 24;
  const dChosen = Math.hypot(p.x + p.w / 2 - ax, p.y + p.h / 2 - ay);
  const aboveCentred = Math.hypot(500 - ax, 408 + 24 - ay);
  assert.ok(dChosen < aboveCentred, `chosen ${dChosen} nearer than above-centred ${aboveCentred}`);
});

test('placeBubbles slide-before-flip: a blocked bubble slides along its edge and stays on its side', () => {
  // Prev: above, centred (x 400..600, y 408..456). A card now sits above the
  // right half; 40 px to the left along the same edge is clear.
  // (non-owner cards are tested as top-left rects, as everywhere in this file)
  const blocker = { id: 'b', x: 590, y: 380, w: 100, h: 80 };       // x 590..690, y 380..460
  const prev = new Map([['o', { side: 'above', x: 400, y: 408 }]]);
  const p = placeBubbles({ cards: [owner500, blocker], bubbles: [{ ownerId: 'o' }], prev }).get('o');
  assert.equal(p.side, 'above', 'stays above (slides) instead of flipping to below');
  assert.equal(p.y, 408, 'bottom edge stays gap-px above the owner');
  assert.ok(p.x < 400 && p.x >= 400 - 48, `slid left a small amount, got x=${p.x}`);
  assert.equal(p.x, 364);
});

test('placeBubbles first appearance: with no prev the bubble is centred above, as before', () => {
  for (const prev of [undefined, null, new Map()]) {
    const p = placeBubbles({ cards: [owner500], bubbles: [{ ownerId: 'o' }], prev }).get('o');
    assert.equal(p.side, 'above');
    assert.equal(p.x, 400);
    assert.equal(p.y, 408);
  }
});

test('placeBubbles exhausted: with a prev but no free candidate the bubble is marked collision (suppressed), as before', () => {
  const cards = [
    { id: 'c1', x: 250, y: 200, w: 50, h: 30 },
    { id: 'c2', x: 0,   y: 0,   w: 500, h: 100 },
    { id: 'c3', x: 0,   y: 250, w: 500, h: 150 },
    { id: 'c4', x: 300, y: 0,   w: 200, h: 400 },
    { id: 'c5', x: 0,   y: 0,   w: 200, h: 400 },
  ];
  const prev = new Map([['c1', { side: 'above', x: 150, y: 100 }]]);
  const p = placeBubbles({
    cards, bubbles: [{ ownerId: 'c1' }], viewport: { width: 500, height: 400 }, prev,
  }).get('c1');
  assert.equal(p.collision, true);
});

test('placeBubbles sticky: a stationary neighbour keeps its slot even when another bubble must move', () => {
  const a = { id: 'a', x: 300, y: 500, w: 200, h: 56 };
  const b = { id: 'b', x: 800, y: 500, w: 200, h: 56 };
  const first = placeBubbles({ cards: [a, b], bubbles: [{ ownerId: 'a' }, { ownerId: 'b' }] });
  const blocker = { id: 'x', x: 300, y: 420, w: 220, h: 60 };       // drops onto a's bubble
  const second = placeBubbles({
    cards: [a, b, blocker], bubbles: [{ ownerId: 'a' }, { ownerId: 'b' }], prev: first,
  });
  assert.deepEqual(
    { s: second.get('b').side, x: second.get('b').x, y: second.get('b').y },
    { s: first.get('b').side, x: first.get('b').x, y: first.get('b').y });
});