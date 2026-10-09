import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusState } from './fleet.mjs';

const CFG = {
  jev: { api_key_env: 'JEV_API_KEY' },
  mode: 'auto',
  jev_authority: 'gate',
};

// status.test.mjs - hermetic tests for `fleet status --json`.
// All filesystem + orca interactions go through injected hooks so the suite
// never touches the real fleet/runs directory or a live Orca.
//
// runDirs is injectable as a function returning a sorted string[] of run ids
// (the live code passes the real `runDirs()` that scans fleet/runs/, the
// tests pass a stub).

// ---------------------------------------------------------------------------
// shape + presence - the JSON contract callers will extend later.
// ---------------------------------------------------------------------------

test('buildStatusState: returns the documented top-level keys', () => {
  const snap = { reclaimable: [], leaks: [], gone: [], unverified: [], leakCheck: 'ok' };
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => snap,
  });
  assert.deepEqual(Object.keys(state).sort(), ['active', 'info', 'jev', 'runs', 'terminals']);
  assert.deepEqual(Object.keys(state.terminals).sort(), ['reclaimable', 'user_takeover_leaks']);
  assert.deepEqual(Object.keys(state.jev).sort(), ['key_set']);
  assert.ok(Array.isArray(state.active));
  assert.ok(Array.isArray(state.info));
  assert.equal(typeof state.runs, 'number');
  assert.equal(typeof state.jev.key_set, 'boolean');
  assert.equal(typeof state.terminals.reclaimable, 'number');
  assert.equal(typeof state.terminals.user_takeover_leaks, 'number');
});

test('buildStatusState: jev.key_set reflects the configured api_key_env, not the raw value', () => {
  const withKey = buildStatusState({
    cfg: { ...CFG, jev: { api_key_env: 'STATUS_TEST_KEY' } },
    env: { STATUS_TEST_KEY: 'set' },
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => null,
  });
  assert.equal(withKey.jev.key_set, true);
  const noKey = buildStatusState({
    cfg: { ...CFG, jev: { api_key_env: 'STATUS_TEST_KEY' } },
    env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => null,
  });
  assert.equal(noKey.jev.key_set, false);
});

// ---------------------------------------------------------------------------
// runs / active - run.json is the source of truth (read via injected readRun).
// Mirrors the live behaviour: a run with no run.json is counted in runs but
// never shows up in active.
// ---------------------------------------------------------------------------

test('buildStatusState: counts all run subdirs; active is the subset whose run.json says active', () => {
  const snap = { reclaimable: [], leaks: [], gone: [], unverified: [], leakCheck: 'ok' };
  const runs = new Map([
    ['r_done',  { status: 'completed' }],
    ['r_live',  { status: 'active' }],
    ['r_live2', { status: 'active' }],
    // r_nojson deliberately omitted -> safeRun() returns null
  ]);
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => ['r_done', 'r_live', 'r_live2', 'r_nojson'],
    readRun: (id) => runs.get(id) ?? null,
    settleSnapshot: () => snap,
  });
  assert.equal(state.runs, 4);
  assert.deepEqual(state.active, ['r_live', 'r_live2']);
});

// ---------------------------------------------------------------------------
// terminals - reused settleSnapshot shape: counts come straight through.
// ---------------------------------------------------------------------------

test('buildStatusState: terminals.reclaimable + user_takeover_leaks reuse settleSnapshot counts', () => {
  const snap = {
    reclaimable: [{ dispatchId: 'a' }, { dispatchId: 'b' }],
    leaks:       [{ dispatchId: 'c' }],
    gone:        [],
    unverified:  [],
    leakCheck:   'ok',
  };
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => snap,
  });
  assert.equal(state.terminals.reclaimable, 2);
  assert.equal(state.terminals.user_takeover_leaks, 1);
});

test('buildStatusState: settleSnapshot null -> terminals report unknown, never throw', () => {
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => null,
  });
  assert.equal(state.terminals.reclaimable, null);
  assert.equal(state.terminals.user_takeover_leaks, null);
});

// ---------------------------------------------------------------------------
// info - the human status prints up to 2 conditional info lines. The JSON
// surface reuses the EXACT same decisions; the count of branches and the
// ordering matches what the human output would print after "terminals".
// Labels are preserved so the printer can reproduce the human line bytes.
// ---------------------------------------------------------------------------

test('buildStatusState: info surfaces leakCheck unavailable and gone dispatchIds', () => {
  const snap = {
    reclaimable: [], leaks: [],
    gone: [{ dispatchId: 'ctx_g1' }, { dispatchId: 'ctx_g2' }],
    unverified: [{ dispatchId: 'ctx_u' }],
    leakCheck: 'unavailable',
  };
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => snap,
  });
  const texts = state.info.map((e) => e.text);
  assert.equal(texts.some((l) => l.includes('ctx_g1') && l.includes('ctx_g2')), true,
    'gone info should list the dispatch ids');
  assert.equal(texts.some((l) => l.includes('leak check unavailable') || l.includes('unverified')), true,
    'unavailable leak check should surface in info');
  // Labels preserved so the printer can reproduce the human line bytes.
  assert.equal(state.info.every((e) => typeof e.label === 'string' && typeof e.text === 'string'), true);
});

test('buildStatusState: clean snapshot -> empty info array (mirrors the human "no info line" case)', () => {
  const snap = { reclaimable: [], leaks: [], gone: [], unverified: [], leakCheck: 'ok' };
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot: () => snap,
  });
  assert.deepEqual(state.info, []);
});

// ---------------------------------------------------------------------------
// no recompute - a single settleSnapshot call backs the terminal counts.
// Required by the spec: "do not recompute the logic a second way".
// ---------------------------------------------------------------------------

test('buildStatusState: settleSnapshot is called exactly once per state build', () => {
  let calls = 0;
  const snap = { reclaimable: [], leaks: [], gone: [], unverified: [], leakCheck: 'ok' };
  const settleSnapshot = () => { calls++; return snap; };
  buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => [],
    readRun: () => null, settleSnapshot,
  });
  assert.equal(calls, 1, 'no second computation of the worker/terminal snapshot');
});

test('buildStatusState: a single runDirs() call backs both runs count and active list', () => {
  let calls = 0;
  const runs = ['r_a', 'r_b'];
  const state = buildStatusState({
    cfg: CFG, env: {},
    runDirs: () => { calls++; return runs; },
    readRun: (id) => id === 'r_b' ? { status: 'active' } : null,
    settleSnapshot: () => ({ reclaimable: [], leaks: [], gone: [], unverified: [], leakCheck: 'ok' }),
  });
  assert.equal(calls, 1, 'runs list is scanned once, not twice');
  assert.equal(state.runs, 2);
  assert.deepEqual(state.active, ['r_b']);
});
