// Orca binary resolution + exec wrapper. Cross-platform, zero dependencies.
// Resolution order is dictated by Orca's own orchestration skill - do not change
// it, and never fall through to another binary on failure (that could silently
// target a different Orca build).
import { execFileSync } from 'node:child_process';
import { mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveOrca(env = process.env) {
  if (env.ORCA_CLI_COMMAND) return { cmd: env.ORCA_CLI_COMMAND, why: 'ORCA_CLI_COMMAND' };
  if (env.ORCA_DEV_REPO_ROOT) return { cmd: 'orca-dev', why: 'ORCA_DEV_REPO_ROOT (dev checkout)' };
  if (process.platform === 'linux' && !env.ORCA_PANE_KEY && !env.ORCA_AGENT_HOOK_PORT) {
    // Bare `orca` on Linux outside an Orca-managed terminal is the GNOME screen
    // reader and starts speech. Never use it there.
    return { cmd: 'orca-ide', why: 'linux outside Orca terminal' };
  }
  return { cmd: 'orca', why: 'default' };
}

export function orca(args, { json = true, allowFailure = false } = {}) {
  const { cmd } = resolveOrca();
  const argv = ['orchestration', ...args, ...(json ? ['--json'] : [])];
  try {
    const out = execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return json ? JSON.parse(out) : out;
  } catch (err) {
    if (allowFailure) return { ok: false, error: String(err.message || err) };
    throw new Error(`orca ${args.join(' ')} failed via "${cmd}": ${err.message}`);
  }
}

// Same exec wrapper for `orca terminal ...` subcommands (the orca() above
// always prefixes 'orchestration', so terminal close needed its own).
export function orcaTerminal(args, { json = true, allowFailure = false } = {}) {
  const { cmd } = resolveOrca();
  const argv = ['terminal', ...args, ...(json ? ['--json'] : [])];
  try {
    const out = execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return json ? JSON.parse(out) : out;
  } catch (err) {
    if (allowFailure) return { ok: false, error: String(err.message || err) };
    throw new Error(`orca terminal ${args.join(' ')} failed via "${cmd}": ${err.message}`);
  }
}

export function orcaStatus() {
  const { cmd } = resolveOrca();
  try {
    const out = execFileSync(cmd, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out);
    const r = j.result || {};
    return { ok: !!j.ok, cmd, app: r.app?.running, runtime: r.runtime?.state, version: r.runtime?.appVersion };
  } catch (err) {
    return { ok: false, cmd, error: String(err.message || err) };
  }
}

// Raw `orca orchestration worker-list` result as an array (null when the call
// fails). Both settle paths build on this so they see one consistent snapshot.
export function listWorkers() {
  const j = orca(['worker-list'], { allowFailure: true });
  if (!j || !j.ok) return null;
  return j.result?.workers || [];
}

// Settled workers holding a terminal. Orca keeps the agent process alive until
// released, so every reclaimable dispatch is a live claude process (~300 MB)
// doing nothing - spec section 9 / hard rule 2: the turn is not done while any
// terminal is reclaimable.
export function reclaimableWorkers() {
  const workers = listWorkers();
  if (workers === null) return null;
  return workers.filter((w) => w.terminalState === 'reclaimable');
}

// user_takeover leaks: a worker the fleet dispatched whose terminal the user
// took over. Orca marks it terminalState 'retained' + resource.retainedReason
// 'user_takeover' (ownershipState 'user_owned'), `worker-release` refuses it,
// and reclaimableWorkers() ignores it - so `fleet settle` used to print
// "nothing to settle" while the claude process stayed alive. Pure selector:
// terminal workers only (succeeded|failed), retained specifically for
// user_takeover, with a closeable handle that is NOT the coordinator's own
// terminal (selfHandle = ORCA_TERMINAL_HANDLE - closing that would kill the
// orchestrator itself).
//
// Liveness: Orca keeps listing a worker as retained/user_takeover even AFTER
// its terminal was closed, so a stale record is not a leak. When liveHandles
// (a Set or array of handles from `orca terminal list`) is given, workers
// whose handle is not in it are excluded. Omitted -> no liveness filter
// (callers that cannot prove liveness must not treat the result as confirmed;
// settleSnapshot handles that).
export function takeoverLeaks(workers, { selfHandle, liveHandles } = {}) {
  if (!Array.isArray(workers)) return [];
  const live = liveHandles == null ? null : (liveHandles instanceof Set ? liveHandles : new Set(liveHandles));
  return workers.filter((w) => {
    if (w.workerState !== 'succeeded' && w.workerState !== 'failed') return false;
    if (w.terminalState !== 'retained') return false;
    if (w.resource?.retainedReason !== 'user_takeover') return false;
    const handle = w.agentTerminalHandle || w.resource?.terminalHandle;
    if (!handle) return false;
    if (selfHandle && handle === selfHandle) return false;
    if (live && !live.has(handle)) return false;
    return true;
  });
}

// Pure: `orca terminal list --json` result -> Set of live terminal handles,
// or null when liveness is unknown (call failed, malformed, or truncated - a
// truncated list cannot prove that a handle is absent).
export function liveHandlesFrom(listResult) {
  if (!listResult || !listResult.ok) return null;
  const r = listResult.result;
  if (!r || !Array.isArray(r.terminals)) return null;
  if (r.truncated) return null;
  return new Set(r.terminals.map((t) => t && t.handle).filter(Boolean));
}

// Live terminal list. --limit is set high so the default page size can never
// truncate the list (a truncated list is treated as liveness-unknown).
function listTerminalsLive() {
  return orcaTerminal(['list', '--limit', '10000'], { allowFailure: true });
}

// One worker-list snapshot + one terminal-list snapshot with every settle
// class derived from them, so status/settle make two Orca calls total.
// Null when worker-list is unavailable (same contract as reclaimableWorkers).
//   reclaimable  terminalState 'reclaimable' (Orca's own worker-release path)
//   leaks        user_takeover workers whose terminal is LIVE - actionable
//   gone         user_takeover records whose terminal no longer exists - not
//                a leak, not counted, informational only
//   unverified   user_takeover candidates when liveness is unknown (terminal
//                list failed/truncated) - never reported as confirmed leaks,
//                never closed
//   leakCheck    'ok' | 'unavailable'
// The list functions are injectable so tests never touch live Orca.
export function settleSnapshot(env = process.env, {
  listWorkers: listWorkersFn = listWorkers,
  listTerminals = listTerminalsLive,
} = {}) {
  const workers = listWorkersFn();
  if (workers === null || workers === undefined) return null;
  const selfHandle = env.ORCA_TERMINAL_HANDLE;
  const reclaimable = workers.filter((w) => w.terminalState === 'reclaimable');
  const candidates = takeoverLeaks(workers, { selfHandle });
  if (candidates.length === 0) {
    return { workers, reclaimable, leaks: [], gone: [], unverified: [], leakCheck: 'ok' };
  }
  const liveHandles = liveHandlesFrom(listTerminals());
  if (liveHandles === null) {
    return { workers, reclaimable, leaks: [], gone: [], unverified: candidates, leakCheck: 'unavailable' };
  }
  const leaks = takeoverLeaks(candidates, { selfHandle, liveHandles });
  const gone = candidates.filter((w) => !leaks.includes(w));
  return { workers, reclaimable, leaks, gone, unverified: [], leakCheck: 'ok' };
}

// Close one leak class above. Hard rule: NO close without an archive - the
// output is first captured via `orca orchestration worker-read --dispatch <id>
// --json` to <archiveDir>/<dispatchId>.terminal.json, and only then is the
// tab closed via `orca terminal close --terminal <handle> --tab --json`.
// If the close fails, a FRESH liveness check (checkLive -> Set of live
// handles, or null when unknown) decides: handle confirmed absent -> the
// terminal was already closed (ok); still live or liveness unknown -> FAIL.
// Every side effect is injectable so tests use fixtures, never live Orca.
export function releaseTakeoverLeaks(leaks, {
  archiveDir,
  runOrchestration = (args) => orca(args, { allowFailure: true }),
  runTerminal = (args) => orcaTerminal(args, { allowFailure: true }),
  checkLive = () => liveHandlesFrom(listTerminalsLive()),
  mkdirSync = fsMkdirSync,
  writeFileSync = fsWriteFileSync,
} = {}) {
  const results = [];
  for (const w of leaks || []) {
    const handle = w.agentTerminalHandle || w.resource?.terminalHandle;
    const read = runOrchestration(['worker-read', '--dispatch', w.dispatchId]);
    if (!read || !read.ok) {
      results.push({
        dispatch: w.dispatchId,
        ok: false,
        note: `user_takeover leak left open: worker-read failed (${String(read?.error || read?.result?.error || 'failed').slice(0, 120)})`,
      });
      continue;
    }
    try {
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, `${w.dispatchId}.terminal.json`), JSON.stringify(read, null, 2) + '\n');
    } catch (err) {
      results.push({
        dispatch: w.dispatchId,
        ok: false,
        note: `user_takeover leak left open: archive write failed (${String(err.message || err).slice(0, 120)})`,
      });
      continue;
    }
    const close = runTerminal(['close', '--terminal', handle, '--tab']);
    if (!close || !close.ok) {
      const closeErr = String(close?.error || close?.result?.error || 'failed').slice(0, 120);
      let live = null;
      try { live = checkLive(); } catch { live = null; }
      if (live instanceof Set && !live.has(handle)) {
        results.push({ dispatch: w.dispatchId, ok: true, note: 'already closed (terminal absent from orca terminal list), output archived' });
        continue;
      }
      results.push({
        dispatch: w.dispatchId,
        ok: false,
        note: `close failed, output archived (${closeErr})${live === null ? ' [liveness re-check unavailable]' : ' [terminal still live]'}`,
      });
      continue;
    }
    results.push({ dispatch: w.dispatchId, ok: true, note: 'closed user_takeover' });
  }
  return results;
}

// Release every reclaimable worker. Returns per-dispatch outcomes. Uses Orca's
// own release path (the `next=` action it prints), which also archives the
// transcript and closes the agent process.
export function releaseAll() {
  const list = reclaimableWorkers();
  if (list === null) return { ok: false, error: 'worker-list unavailable' };
  const results = [];
  for (const w of list) {
    const r = orca(['worker-release', '--dispatch', w.dispatchId], { allowFailure: true });
    results.push({
      dispatch: w.dispatchId,
      ok: !!(r && r.ok),
      note: !r || !r.ok ? String(r?.error || r?.result?.error || 'failed').slice(0, 120) : '',
    });
  }
  return { ok: results.every((r) => r.ok), count: results.length, results };
}

// Pure settle-side print helper for a releaseAll() return value. `fleet
// settle` used to do `for (const r of res.results)` inline, which threw
// "res.results is not iterable" when releaseAll() could not even list the
// workers ({ ok:false, error:'worker-list unavailable' } has no results
// array) - the crash hid the real failure and skipped the leak section.
// Returns { lines, allOk, releaseFailed }: lines are ready to console.log
// with the settle prefixes ('ok  '/'FAIL'), allOk mirrors per-result health,
// and releaseFailed marks a release-LEVEL failure (no results at all), which
// the caller must turn into exit 1 regardless of the after-snapshot.
export function printReleaseResults(res) {
  if (!res || !Array.isArray(res.results)) {
    const why = res && res.error ? res.error : String(res);
    return { lines: [`FAIL  release: ${why}`], allOk: false, releaseFailed: true };
  }
  const lines = res.results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.dispatch}${r.note ? '  ' + r.note : ''}`);
  return { lines, allOk: !!res.ok, releaseFailed: false };
}
