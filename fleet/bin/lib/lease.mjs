// Run lease + resume (spec 16.3). The orchestrator is a single point of failure
// by design: its context is a cache, runs/ on disk is the truth. A resume must
// therefore reconstruct from FILES and reconcile against Orca, never from memory.
//
// The lease exists to stop two orchestrators double-dispatching into one run.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { orca } from './orca.mjs';

export const LEASE_MS = 20 * 60 * 1000;   // longer than the max blocking wait (15 min)

export function readRun(dir) { return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')); }
export function writeRun(dir, meta) { writeFileSync(join(dir, 'run.json'), JSON.stringify(meta, null, 1)); }

export function acquire(dir, sessionId, { takeover = false, now = Date.now() } = {}) {
  const meta = readRun(dir);
  const held = meta.lease && meta.lease.expires_at > now && meta.lease.session !== sessionId;
  if (held && !takeover) {
    return { ok: false, reason: 'lease_held', holder: meta.lease.session, expires_in_ms: meta.lease.expires_at - now };
  }
  meta.lease = { session: sessionId, acquired_at: now, expires_at: now + LEASE_MS };
  meta.orchestrator_session = sessionId;
  writeRun(dir, meta);
  return { ok: true, session: sessionId, expires_at: meta.lease.expires_at, took_over: held && takeover };
}

export function heartbeat(dir, sessionId, now = Date.now()) {
  const meta = readRun(dir);
  if (meta.lease && meta.lease.session !== sessionId) return { ok: false, reason: 'not_holder' };
  meta.lease = { session: sessionId, acquired_at: meta.lease?.acquired_at ?? now, expires_at: now + LEASE_MS };
  writeRun(dir, meta);
  return { ok: true, expires_at: meta.lease.expires_at };
}

export function release(dir, sessionId) {
  const meta = readRun(dir);
  if (meta.lease?.session !== sessionId) return { ok: false, reason: 'not_holder' };
  delete meta.lease;
  writeRun(dir, meta);
  return { ok: true };
}

// Reconcile disk (what was INTENDED) against Orca (what is LIVE).
export function reconcile(dir, orcaRunId, { orchestrator = orca } = {}) {
  const meta = readRun(dir);
  let live = [];
  try {
    const r = orchestrator(['worker-list', '--run', orcaRunId]);
    live = (r?.result?.workers || r?.result?.rows || []).map(w => ({
      dispatch: w.dispatchId || w.dispatch_id,
      state: w.terminalState || w.terminal_state,
      liveness: w.liveness?.status || w.projection?.liveness,
    }));
  } catch (e) { return { ok: false, reason: 'orca_unreachable', detail: String(e.message || e) }; }

  const tasks = existsSync(join(dir, 'tasks.jsonl'))
    ? readFileSync(join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const dispatched = new Set(tasks.map(t => t.dispatch).filter(Boolean));
  const liveIds = new Set(live.map(l => l.dispatch).filter(Boolean));

  return {
    ok: true, run: meta.run_id, orca_run: orcaRunId,
    intended: dispatched.size, live: liveIds.size,
    settled_while_down: live.filter(l => l.state === 'released' || l.liveness === 'exited').length,
    orphans: [...liveIds].filter(id => !dispatched.has(id)),          // live but unrecorded
    missing: [...dispatched].filter(id => !liveIds.has(id)),          // recorded but not live
    next_action: 're-decide only undecided work; settle every settled terminal; never re-dispatch a settled task (spec 16.3)',
  };
}
