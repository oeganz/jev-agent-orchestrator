// Model decision layer (spec 15). Three-way split:
//   JEV classifies complexity (it cannot compute cost),
//   code maps (role x complexity) -> slot using the configured policy,
//   the orchestrator/user approves, with the measured cost of that slot shown.
//
// Escalation is evidence-driven only: a JEV flag, a gate rejection, or a test
// failure. Never "this feels hard".
import { askJev } from './jev.mjs';

export const LADDER = ['haiku', 'sonnet', 'opus', 'fable'];

const CLASSIFY_Q = {
  complexity: {
    type: 'choice',
    instructions: 'How complex is this engineering task? Judge by how much must be understood and coordinated, not by how many lines change.',
    criteria: {
      trivial: 'A single obvious change, no design decisions, one file',
      small: 'A contained change, few files, clear approach',
      medium: 'Multiple files or a design decision; some coordination required',
      large: 'Cross-cutting; design decisions with trade-offs; many touchpoints',
    },
  },
};

// JEV classifies; if it is unavailable or unconfident we fall back to a
// deterministic size bucket, because a model choice still has to be made.
export function bucketByScan(scan) {
  if (!scan || !scan.files) return 'small';
  if (scan.files <= 2 && scan.bytes < 8000) return 'trivial';
  if (scan.files <= 10 && scan.bytes < 60000) return 'small';
  if (scan.files <= 60) return 'medium';
  return 'large';
}

export async function classify(request, scan, cfg, { askJevImpl = askJev } = {}) {
  const state = 'REQUEST: ' + request + '\n\nSCOPE SCAN: ' + JSON.stringify(scan || {});
  const r = await askJevImpl(state, CLASSIFY_Q, cfg);
  if (r.ok) {
    const a = r.answers.complexity;
    if (a && a.confidence >= (cfg.abstain ?? 0.6)) {
      return { complexity: a.choice, source: 'jev', confidence: a.confidence, probabilities: a.probabilities };
    }
    return { complexity: bucketByScan(scan), source: 'scan-fallback (jev unconfident)', confidence: a?.confidence ?? null };
  }
  return { complexity: bucketByScan(scan), source: 'scan-fallback (jev ' + r.reason + ')', confidence: null };
}

export function pickSlot(role, complexity, policy) {
  const p = policy[role];
  if (!p) return null;
  return p[complexity] || p['*'] || null;
}

// spec 15.8: the fleet names a SLOT; the machine supplies the id. Omit --model
// entirely when the slot has no env mapping, so the worker inherits the default.
export function resolveSlot(slot, tiers = {}, env = process.env, override = null) {
  if (override) return { model: override, path: 'override' };
  const t = tiers[slot];
  if (!t) return { model: null, path: 'unknown-slot' };
  const id = env[t.env];
  return id ? { model: id, path: 'env:' + t.env } : { model: null, path: 'inherit' };
}

// `rules` is the escalation config (on_jev_flag / on_gate_reject / on_test_fail).
// An earlier version read rules from the state object instead, so a gate
// rejection never escalated - the exact silent no-op this function exists to
// prevent. Caught by the test below before it shipped.
export function shouldEscalate(state, rules = {}) {
  const { jevVerdict, gateVerdict, testVerdict, escalations = 0 } = state || {};
  const max = rules.max_escalations ?? 2;
  if (escalations >= max) return { escalate: false, reason: "max_escalations_reached" };
  const flagAt = rules.on_jev_flag === false ? null : (typeof rules.on_jev_flag === "number" ? rules.on_jev_flag : 0.55);
  if (flagAt !== null && jevVerdict && jevVerdict.maxFlag > flagAt)
    return { escalate: true, reason: "jev_flag " + jevVerdict.maxFlag };
  if (rules.on_gate_reject !== false && gateVerdict === "rework") return { escalate: true, reason: "gate_rejected" };
  if (rules.on_test_fail !== false && testVerdict === "rework-needed") return { escalate: true, reason: "test_failed" };
  return { escalate: false, reason: "clean" };
}
export function nextSlot(current, ladder = LADDER) {
  const i = ladder.indexOf(current);
  if (i === -1) return null;
  return i + 1 < ladder.length ? ladder[i + 1] : null;   // null = already at the top
}
