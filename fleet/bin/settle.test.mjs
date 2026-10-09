import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { takeoverLeaks, releaseTakeoverLeaks, liveHandlesFrom, settleSnapshot, printReleaseResults } from './lib/orca.mjs';

// takeoverLeaks + releaseTakeoverLeaks are the pure, injected seams; the live
// settleSnapshot() wrapper just combines takeoverLeaks with the existing
// terminalState==='reclaimable' filter over one worker-list call.

// Fixture builder matching the real `orca orchestration worker-list --json`
// shape: {ok, result:{workers:[{dispatchId, workerState, terminalState,
// agentTerminalHandle, resource:{ownershipState, releaseState,
// retainedReason, terminalHandle}}]}}.
function worker(over = {}) {
  return {
    dispatchId: 'ctx_fixture',
    workerState: 'succeeded',
    terminalState: 'retained',
    agentTerminalHandle: 'term_worker',
    resource: {
      ownershipState: 'user_owned',
      releaseState: 'retained',
      retainedReason: 'user_takeover',
      terminalHandle: 'term_worker',
    },
    ...over,
  };
}

function withResource(w, over = {}) {
  return { ...w, resource: { ...w.resource, ...over } };
}

// ---------------------------------------------------------------------------
// takeoverLeaks - the pure selector for user_takeover leaks. Orca refuses
// `worker-release` on these (terminalState 'retained', ownershipState
// 'user_owned'), so reclaimableWorkers() never sees them and `fleet settle`
// printed "nothing to settle" while the claude process stayed alive.
// ---------------------------------------------------------------------------

test('takeoverLeaks (a): succeeded + retained + user_takeover + foreign handle -> selected', () => {
  const w = worker({ dispatchId: 'ctx_a', agentTerminalHandle: 'term_a' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 1, 'expected exactly the one leak to be selected');
  assert.equal(sel[0].dispatchId, 'ctx_a');
});

test('takeoverLeaks: failed + retained + user_takeover + foreign handle -> selected too', () => {
  const w = worker({ dispatchId: 'ctx_f', workerState: 'failed', agentTerminalHandle: 'term_f' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 1, 'failed workers are leaks just like succeeded ones');
  assert.equal(sel[0].dispatchId, 'ctx_f');
});

test('takeoverLeaks (b): leak whose handle === selfHandle is excluded (never close the coordinator)', () => {
  const w = worker({ dispatchId: 'ctx_self', agentTerminalHandle: 'term_mine' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 0, 'own terminal must never be selected');
});

test('takeoverLeaks (c): running worker is excluded even if marked retained/user_takeover', () => {
  const w = worker({ dispatchId: 'ctx_run', workerState: 'running' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 0, 'running workers must not be closed');
});

test('takeoverLeaks (d): reclaimable worker is NOT selected (handled by the existing release path)', () => {
  const w = worker({
    dispatchId: 'ctx_rc',
    terminalState: 'reclaimable',
    resource: { ownershipState: 'agent_owned', releaseState: 'reclaimable', retainedReason: null, terminalHandle: 'term_rc' },
  });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 0, 'reclaimable workers go through worker-release, not takeover close');
});

test('takeoverLeaks (e): retained for a reason other than user_takeover is excluded', () => {
  const w = withResource(worker({ dispatchId: 'ctx_other' }), { retainedReason: 'manual_hold' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 0, 'only user_takeover retention is a fleet-settle leak');
});

test('takeoverLeaks: no terminal handle at all -> excluded', () => {
  const w = worker({ dispatchId: 'ctx_nohandle', agentTerminalHandle: undefined });
  delete w.resource.terminalHandle;
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 0, 'without a handle there is nothing to close');
});

test('takeoverLeaks: resource.terminalHandle is used when agentTerminalHandle is missing', () => {
  const w = withResource(
    worker({ dispatchId: 'ctx_rh', agentTerminalHandle: undefined }),
    { terminalHandle: 'term_from_resource' },
  );
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine' });
  assert.equal(sel.length, 1, 'a leak reported only via resource.terminalHandle still counts');
  const w2 = withResource(
    worker({ dispatchId: 'ctx_rh2', agentTerminalHandle: undefined }),
    { terminalHandle: 'term_mine' },
  );
  assert.equal(takeoverLeaks([w2], { selfHandle: 'term_mine' }).length, 0,
    'selfHandle exclusion must also apply to resource.terminalHandle');
});

test('takeoverLeaks: no selfHandle given -> nothing is excluded on handle grounds', () => {
  const sel = takeoverLeaks([worker({ dispatchId: 'ctx_x', agentTerminalHandle: 'term_x' })], {});
  assert.equal(sel.length, 1);
});

test('takeoverLeaks: empty and missing inputs return []', () => {
  assert.deepEqual(takeoverLeaks([], { selfHandle: 't' }), []);
  assert.deepEqual(takeoverLeaks(undefined, { selfHandle: 't' }), []);
  assert.deepEqual(takeoverLeaks(null, {}), []);
});

test('takeoverLeaks: a mixed list selects exactly the leaks', () => {
  const list = [
    worker({ dispatchId: 'ctx_leak1', agentTerminalHandle: 'term_l1' }),
    worker({ dispatchId: 'ctx_running', workerState: 'running' }),
    worker({ dispatchId: 'ctx_self', agentTerminalHandle: 'term_mine' }),
    worker({ dispatchId: 'ctx_reclaim', terminalState: 'reclaimable' }),
    withResource(worker({ dispatchId: 'ctx_hold' }), { retainedReason: 'manual_hold' }),
    worker({ dispatchId: 'ctx_leak2', workerState: 'failed', agentTerminalHandle: 'term_l2' }),
  ];
  const sel = takeoverLeaks(list, { selfHandle: 'term_mine' });
  assert.deepEqual(sel.map((w) => w.dispatchId), ['ctx_leak1', 'ctx_leak2']);
});

// ---------------------------------------------------------------------------
// releaseTakeoverLeaks - archive first (worker-read -> runs/_archive/<id>.
// terminal.json), then close the terminal tab. No archive -> no close.
// All orca interaction is injected; nothing here touches live Orca.
// ---------------------------------------------------------------------------

function makeLeak(dispatch, handle) {
  return worker({ dispatchId: dispatch, agentTerminalHandle: handle });
}

function okRead(dispatch) {
  return { id: 'rd-' + dispatch, ok: true, result: { dispatchId: dispatch, source: 'terminal', terminal: { handle: 'term', tail: [] } } };
}
function okClose(handle) {
  return { ok: true, result: { close: { handle, closeMode: 'tab', ptyKilled: true } } };
}

// The injected runners receive argv arrays WITHOUT --json (the real ones add
// it in the exec wrapper); these fakes assert on the semantic args.
function fakeRunners({ read = okRead, close = okClose, log = [] } = {}) {
  return {
    log,
    runOrchestration: (args) => { log.push(['read', ...args]); return typeof read === 'function' ? read(args[2] || args[1]) : read; },
    runTerminal: (args) => { log.push(['close', ...args]); return typeof close === 'function' ? close(args[2]) : close; },
  };
}

test('releaseTakeoverLeaks: archives worker-read output, then closes the tab, in that order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_ok', 'term_ok')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
    });
    assert.equal(res.length, 1);
    assert.equal(res[0].ok, true, 'expected ok, note=' + res[0].note);
    assert.equal(res[0].dispatch, 'ctx_ok');
    assert.equal(res[0].note, 'closed user_takeover');
    // worker-read ran with the dispatch id and BEFORE the close.
    assert.deepEqual(f.log[0], ['read', 'worker-read', '--dispatch', 'ctx_ok']);
    assert.deepEqual(f.log[1], ['close', 'close', '--terminal', 'term_ok', '--tab']);
    // The archive file exists and holds the exact worker-read JSON.
    const p = join(dir, 'ctx_ok.terminal.json');
    assert.ok(existsSync(p), 'archive file missing: ' + p);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), okRead('ctx_ok'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: close uses resource.terminalHandle when agentTerminalHandle is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ log: [] });
    const w = withResource(worker({ dispatchId: 'ctx_r', agentTerminalHandle: undefined }), { terminalHandle: 'term_res' });
    const res = releaseTakeoverLeaks([w], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
    });
    assert.equal(res[0].ok, true);
    assert.deepEqual(f.log[1], ['close', 'close', '--terminal', 'term_res', '--tab']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: failed worker-read -> NOT closed, failure recorded, no archive file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ read: { ok: false, error: 'dispatch not found' }, log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_rd', 'term_rd')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
    });
    assert.equal(res[0].ok, false, 'a failed read must not report ok');
    assert.match(res[0].note, /user_takeover/, 'note should name the leak class');
    assert.match(res[0].note, /worker-read/, 'note should say the read failed');
    assert.equal(f.log.length, 1, 'terminal close must NOT run without an archive');
    assert.ok(!existsSync(join(dir, 'ctx_rd.terminal.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: archive write failure -> NOT closed, failure recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_wr', 'term_wr')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      writeFileSync: () => { throw new Error('disk full'); },
    });
    assert.equal(res[0].ok, false);
    assert.match(res[0].note, /archive/);
    assert.equal(f.log.length, 1, 'close must not run when the archive write failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: close failure -> ok false with the close error, archive still written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ close: { ok: false, error: 'tab not found' }, log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_cf', 'term_cf')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      // T1r2: a failed close triggers a fresh liveness check; inject it so
      // this test never queries live Orca. Handle still live -> FAIL stands.
      checkLive: () => new Set(['term_cf']),
    });
    assert.equal(res[0].ok, false);
    assert.match(res[0].note, /close failed/);
    assert.ok(existsSync(join(dir, 'ctx_cf.terminal.json')), 'archive must exist even if the close failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: multiple leaks -> one result each, in input order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_1', 'term_1'), makeLeak('ctx_2', 'term_2')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
    });
    assert.deepEqual(res.map((r) => r.dispatch), ['ctx_1', 'ctx_2']);
    assert.ok(res.every((r) => r.ok));
    assert.ok(existsSync(join(dir, 'ctx_1.terminal.json')));
    assert.ok(existsSync(join(dir, 'ctx_2.terminal.json')));
    assert.equal(f.log.length, 4, 'read+close per leak');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: empty leak list -> no calls, no results', () => {
  const f = fakeRunners({ log: [] });
  const res = releaseTakeoverLeaks([], {
    runOrchestration: f.runOrchestration,
    runTerminal: f.runTerminal,
    archiveDir: join(tmpdir(), 'settle-unused-'),
  });
  assert.deepEqual(res, []);
  assert.equal(f.log.length, 0);
});

// ---------------------------------------------------------------------------
// Liveness (T1r2). Orca keeps listing a worker as retained/user_takeover even
// after its terminal has been closed, so a leak only counts when its handle is
// a LIVE terminal in `orca terminal list --json`. Live repro: ctx_91865b55d516
// -> term_bf42572b, absent from terminal list, reported as a leak forever and
// `fleet settle` exited 1 on every run trying to close it.
// ---------------------------------------------------------------------------

// Fixture matching `orca terminal list --json`:
// {ok, result:{terminals:[{handle, orphaned, worktreePath, ...}], totalCount, truncated}}.
function terminalList(handles, over = {}) {
  return {
    ok: true,
    result: {
      terminals: handles.map((h) => ({ handle: h, orphaned: false, worktreePath: 'C:/x' })),
      totalCount: handles.length,
      truncated: false,
      ...over,
    },
  };
}

test('liveHandlesFrom: ok list -> Set of handles', () => {
  const s = liveHandlesFrom(terminalList(['term_a', 'term_b']));
  assert.ok(s instanceof Set);
  assert.deepEqual([...s].sort(), ['term_a', 'term_b']);
});

test('liveHandlesFrom: failed / malformed / truncated list -> null (liveness unknown)', () => {
  assert.equal(liveHandlesFrom({ ok: false, error: 'orca down' }), null);
  assert.equal(liveHandlesFrom(null), null);
  assert.equal(liveHandlesFrom(undefined), null);
  assert.equal(liveHandlesFrom({ ok: true, result: {} }), null, 'no terminals array -> unknown');
  assert.equal(liveHandlesFrom(terminalList(['term_a'], { truncated: true })), null,
    'a truncated list cannot prove a handle is absent');
});

test('takeoverLeaks (f): retained+user_takeover but handle absent from liveHandles -> excluded', () => {
  const w = worker({ dispatchId: 'ctx_91865b55d516', agentTerminalHandle: 'term_bf42572b' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine', liveHandles: new Set(['term_mine', 'term_other']) });
  assert.equal(sel.length, 0, 'a dispatch whose terminal is already gone is not a leak');
});

test('takeoverLeaks (g): retained+user_takeover with handle present in liveHandles -> selected', () => {
  const w = worker({ dispatchId: 'ctx_g', agentTerminalHandle: 'term_g' });
  const sel = takeoverLeaks([w], { selfHandle: 'term_mine', liveHandles: new Set(['term_mine', 'term_g']) });
  assert.deepEqual(sel.map((x) => x.dispatchId), ['ctx_g']);
  // resource.terminalHandle is checked against liveness too.
  const w2 = withResource(worker({ dispatchId: 'ctx_g2', agentTerminalHandle: undefined }), { terminalHandle: 'term_g2' });
  assert.equal(takeoverLeaks([w2], { liveHandles: new Set(['term_g2']) }).length, 1);
  assert.equal(takeoverLeaks([w2], { liveHandles: new Set(['term_g']) }).length, 0);
  // selfHandle exclusion still wins even when the handle is live.
  const self = worker({ dispatchId: 'ctx_self', agentTerminalHandle: 'term_mine' });
  assert.equal(takeoverLeaks([self], { selfHandle: 'term_mine', liveHandles: new Set(['term_mine']) }).length, 0);
});

function fakeOrcaLists({ workers, terminals }) {
  const calls = { workers: 0, terminals: 0 };
  return {
    calls,
    listWorkers: () => { calls.workers++; return workers; },
    listTerminals: () => { calls.terminals++; return terminals; },
  };
}

test('settleSnapshot: one worker-list + one terminal-list; live leaks vs already-gone split', () => {
  const live = worker({ dispatchId: 'ctx_live', agentTerminalHandle: 'term_live' });
  const gone = worker({ dispatchId: 'ctx_gone', agentTerminalHandle: 'term_gone' });
  const rc = worker({ dispatchId: 'ctx_rc', terminalState: 'reclaimable' });
  const f = fakeOrcaLists({ workers: [live, gone, rc], terminals: terminalList(['term_live', 'term_mine']) });
  const snap = settleSnapshot({ ORCA_TERMINAL_HANDLE: 'term_mine' }, { listWorkers: f.listWorkers, listTerminals: f.listTerminals });
  assert.equal(f.calls.workers, 1);
  assert.equal(f.calls.terminals, 1, 'terminal list fetched exactly once per snapshot');
  assert.equal(snap.leakCheck, 'ok');
  assert.deepEqual(snap.leaks.map((w) => w.dispatchId), ['ctx_live']);
  assert.deepEqual(snap.gone.map((w) => w.dispatchId), ['ctx_gone'], 'already-gone dispatch is informational, not a leak');
  assert.deepEqual(snap.unverified, []);
  assert.deepEqual(snap.reclaimable.map((w) => w.dispatchId), ['ctx_rc']);
});

test('settleSnapshot: no takeover candidates -> a failed terminal list does not make the verdict unknown', () => {
  const f = fakeOrcaLists({ workers: [], terminals: { ok: false, error: 'down' } });
  const snap = settleSnapshot({}, { listWorkers: f.listWorkers, listTerminals: f.listTerminals });
  assert.equal(snap.leaks.length, 0);
  assert.equal(snap.unverified.length, 0);
  assert.equal(snap.gone.length, 0);
});

test('settleSnapshot: worker-list unavailable -> null (unchanged contract)', () => {
  const f = fakeOrcaLists({ workers: null, terminals: terminalList([]) });
  assert.equal(settleSnapshot({}, { listWorkers: f.listWorkers, listTerminals: f.listTerminals }), null);
});

test('(h): terminal list unavailable -> snapshot reports unknown, no confirmed leaks, release closes nothing', () => {
  const cand = worker({ dispatchId: 'ctx_h', agentTerminalHandle: 'term_h' });
  const f = fakeOrcaLists({ workers: [cand], terminals: { ok: false, error: 'Command failed: orca terminal list' } });
  const snap = settleSnapshot({ ORCA_TERMINAL_HANDLE: 'term_mine' }, { listWorkers: f.listWorkers, listTerminals: f.listTerminals });
  assert.equal(snap.leakCheck, 'unavailable');
  assert.equal(snap.leaks.length, 0, 'leaks must not be reported as confirmed when liveness is unknown');
  assert.deepEqual(snap.unverified.map((w) => w.dispatchId), ['ctx_h'], 'candidates surface as unverified');
  assert.equal(snap.gone.length, 0, 'nothing can be called gone without a list either');
  const r = fakeRunners({ log: [] });
  const res = releaseTakeoverLeaks(snap.leaks, {
    runOrchestration: r.runOrchestration,
    runTerminal: r.runTerminal,
    archiveDir: join(tmpdir(), 'settle-unused-h'),
  });
  assert.deepEqual(res, []);
  assert.equal(r.log.length, 0, 'no worker-read and no close when liveness is unknown');
});

test('(h2): truncated terminal list is treated as unavailable, not as "absent"', () => {
  const cand = worker({ dispatchId: 'ctx_h2', agentTerminalHandle: 'term_h2' });
  const f = fakeOrcaLists({ workers: [cand], terminals: terminalList(['term_other'], { truncated: true }) });
  const snap = settleSnapshot({}, { listWorkers: f.listWorkers, listTerminals: f.listTerminals });
  assert.equal(snap.leakCheck, 'unavailable');
  assert.equal(snap.gone.length, 0);
  assert.equal(snap.unverified.length, 1);
});

test('releaseTakeoverLeaks (i): close fails + fresh liveness says absent -> ok "already closed"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ close: { ok: false, error: 'Command failed: orca terminal close --terminal term_i' }, log: [] });
    let checks = 0;
    const res = releaseTakeoverLeaks([makeLeak('ctx_i', 'term_i')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      checkLive: () => { checks++; return new Set(['term_other']); },
    });
    assert.equal(checks, 1, 'a fresh liveness check runs after the failed close');
    assert.equal(res[0].ok, true, 'note=' + res[0].note);
    assert.match(res[0].note, /already closed/);
    assert.ok(existsSync(join(dir, 'ctx_i.terminal.json')), 'archive still written first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks (j): close fails + handle still live -> FAIL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ close: { ok: false, error: 'permission denied' }, log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_j', 'term_j')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      checkLive: () => new Set(['term_j']),
    });
    assert.equal(res[0].ok, false);
    assert.match(res[0].note, /close failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks (j2): close fails + fresh liveness check unavailable -> FAIL (never assume closed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ close: { ok: false, error: 'boom' }, log: [] });
    const res = releaseTakeoverLeaks([makeLeak('ctx_j2', 'term_j2')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      checkLive: () => null,
    });
    assert.equal(res[0].ok, false);
    assert.match(res[0].note, /close failed/);
    assert.match(res[0].note, /liveness/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseTakeoverLeaks: successful close does not need a liveness check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-arch-'));
  try {
    const f = fakeRunners({ log: [] });
    let checks = 0;
    const res = releaseTakeoverLeaks([makeLeak('ctx_s', 'term_s')], {
      runOrchestration: f.runOrchestration,
      runTerminal: f.runTerminal,
      archiveDir: dir,
      checkLive: () => { checks++; return new Set(); },
    });
    assert.equal(res[0].ok, true);
    assert.equal(checks, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// printReleaseResults - the extracted settle print loop (run 20261007-1009
// T1-small-fixes). cmdSettle used to do `for (const r of res.results)` on the
// releaseAll() return, but when worker-list is unavailable releaseAll()
// returns `{ ok:false, error:'worker-list unavailable' }` with NO results
// array, so settle crashed with "res.results is not iterable" instead of
// reporting the failure and continuing to the leak section. Pure: takes the
// releaseAll() return value and returns the lines to print (no console).
// ---------------------------------------------------------------------------

test('printReleaseResults: happy path prints one "ok" line per result and ok stays true', () => {
  const res = {
    ok: true,
    count: 2,
    results: [
      { dispatch: 'ctx_1', ok: true, note: '' },
      { dispatch: 'ctx_2', ok: true, note: 'released' },
    ],
  };
  const { lines, allOk, releaseFailed } = printReleaseResults(res);
  assert.equal(allOk, true);
  assert.equal(releaseFailed, false);
  assert.deepEqual(lines, ['ok    ctx_1', 'ok    ctx_2  released']);
});

test('printReleaseResults: per-result failure prints FAIL and flips allOk', () => {
  const res = {
    ok: false,
    count: 1,
    results: [{ dispatch: 'ctx_bad', ok: false, note: 'refused' }],
  };
  const { lines, allOk, releaseFailed } = printReleaseResults(res);
  assert.equal(allOk, false);
  assert.equal(releaseFailed, false, 'a per-result failure is not a release-level failure');
  assert.deepEqual(lines, ['FAIL  ctx_bad  refused']);
});

test('printReleaseResults: releaseAll() unavailable shape {ok:false,error} -> FAIL line, allOk false, no throw', () => {
  const res = { ok: false, error: 'worker-list unavailable' };
  const { lines, allOk, releaseFailed } = printReleaseResults(res);
  assert.equal(allOk, false);
  assert.equal(releaseFailed, true, 'the caller must force exit 1 - the after-snapshot is likely null too');
  assert.deepEqual(lines, ['FAIL  release: worker-list unavailable']);
});

test('printReleaseResults: null/undefined release result is handled the same way', () => {
  assert.deepEqual(printReleaseResults(null), { lines: ['FAIL  release: null'], allOk: false, releaseFailed: true });
  assert.deepEqual(printReleaseResults(undefined), { lines: ['FAIL  release: undefined'], allOk: false, releaseFailed: true });
});
