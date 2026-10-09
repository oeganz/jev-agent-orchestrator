// JEV client with a REAL fallback path (spec 14.9). Never throws for an
// operational failure - an unavailable filter degrades the gate to orchestrator
// review, it never auto-passes and it never crashes the run.
import { loadEnv } from './env.mjs';
loadEnv();   // pick up JEV_API_KEY from Agent/Orchestrator/.env if not exported

const DEFAULT_TIMEOUT_MS = 8000;
// LAST-RESORT default only: every caller in this codebase (askJevChain via
// askFromConfig -> cfg.jev.providers[*].base_url) supplies an explicit baseUrl,
// so DEFAULT_BASE_URL is unreachable on the supported code path. It exists
// solely so a DIRECT `askJev` call (no provider list, no config) does not throw
// on lookup - the JEV_BASE_URL env read here is honoured in that one direct
// case. JEV_BASE_URL override of the PRIMARY provider on the supported path is
// handled in askFromConfig, not here. The placeholder MUST be a valid URL
// shape so the breaker-key code does not throw on lookup.
const DEFAULT_BASE_URL = (process.env.JEV_BASE_URL && process.env.JEV_BASE_URL.trim())
  || 'https://<jev-host>/v1/systemone';

// One circuit breaker PER PROVIDER (keyed by base_url). The earlier
// module-global breaker meant an open primary also blocked a healthy
// secondary, and a secondary success reset the primary's failure count -
// both break failover (T4). No argument to breakerStatus() reports the
// default/primary provider's breaker.
const breakers = new Map();

function breakerFor(key) {
  let s = breakers.get(key);
  if (!s) { s = { failures: 0, openUntil: 0 }; breakers.set(key, s); }
  return s;
}

export function breakerStatus(provider = DEFAULT_BASE_URL, now = Date.now()) {
  const s = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  return { open: now < s.openUntil, failures: s.failures, openUntil: s.openUntil };
}
export function resetBreaker() { breakers.clear(); }

function degrade(reason, detail) {
  return { ok: false, degraded: true, reason, detail, action: 'orchestrator_review' };
}

export async function askJev(state, questions, cfg = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    model = 'jev-1-13-free',
    apiKey = process.env.JEV_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 1,
    breaker = { failures_to_open: 3, cooldown_ms: 300000 },
    fetchImpl = globalThis.fetch,
  } = cfg;

  if (!apiKey) return degrade('auth', 'no API key (set JEV_API_KEY)');

  const st = breakerFor(baseUrl);
  const now = Date.now();
  if (now < st.openUntil) {
    return degrade('circuit_open', `breaker open for ${Math.round((st.openUntil - now) / 1000)}s more`);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
      if (attempt === retries) return record(baseUrl, reason, String(err.message || err), breaker);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      // A missing/expired key is a CONFIG error, not an outage. Fail loudly.
      return { ok: false, degraded: false, fatal: true, reason: 'auth',
        detail: `HTTP ${res.status} - credential rejected`, action: 'stop' };
    }
    if (res.status === 429 || res.status === 529) {
      if (attempt === retries) return record(baseUrl, 'rate_limited', `HTTP ${res.status}`, breaker);
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status >= 500) {
      if (attempt === retries) return record(baseUrl, 'unavailable', `HTTP ${res.status}`, breaker);
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) return degrade('unavailable', `HTTP ${res.status}`);

    let body;
    try { body = await res.json(); } catch { return record(baseUrl, 'malformed', 'response was not JSON', breaker); }
    if (body === null || typeof body !== 'object')
      return record(baseUrl, 'malformed', 'response body was not an object', breaker);
    if (body.error) return record(baseUrl, 'unavailable', String(body.error.code || body.error.message || 'error'), breaker);
    if (!body.answers) return record(baseUrl, 'malformed', 'no answers in response', breaker);

    breakers.set(baseUrl, { failures: 0, openUntil: 0 });   // success closes the circuit
    return { ok: true, answers: body.answers, model: body.model, usage: body.usage };
  }
  return degrade('unavailable', 'exhausted retries');
}

function record(baseUrl, reason, detail, breaker) {
  const st = breakerFor(baseUrl);
  st.failures += 1;
  if (st.failures >= (breaker.failures_to_open ?? 3)) {
    st.openUntil = Date.now() + (breaker.cooldown_ms ?? 300000);
  }
  return degrade(reason, detail);
}

// Apply the gate policy (spec 6, hardened T4). JEV decides ONLY when confident
// AND the answer is well-formed; every other branch escalates. Malformed input
// escalates BEFORE flag-first - garbage can never authorise anything, not even
// a rework. Returns decided_by so the caller never has to infer who decided.
// Flag-first (T5) also escalates: the rework it returns is a RECOMMENDATION
// (`recommendation: 'rework'`), decided_by 'escalate' - the flag still blocks
// any accept, but the orchestrator makes the call.
export function gateVerdict(detail, {
  flag = 0.55,
  abstain = 0.6,
  autoApply = 0.8,
  band = [0.4, 0.6],
  decisive = ['accept', 'pass', 'verified', 'rework', 'rework-needed'],
} = {}) {
  if (!detail.ok) return { verdict: 'orchestrator', decided_by: 'fallback', reason: detail.reason };

  const malformed = (branch) => ({
    verdict: 'orchestrator', decided_by: 'escalate', branch, flags, maxFlag: null, chosenProb: null, topProb: null,
  });
  const escalate = (branch, flags, maxFlag, prob) => ({
    verdict: 'orchestrator', decided_by: 'escalate', branch, flags, maxFlag, chosenProb: prob, topProb: prob,
  });

  const a = detail.answers ?? {};
  const flags = {};
  for (const [k, v] of Object.entries(a)) if (v?.type === 'noul') flags[k] = v.noul;
  const choiceAnswers = Object.values(a).filter(v => v?.type === 'choice');

  // --- malformed: the shape itself is wrong, each with a distinct branch ---
  if (choiceAnswers.length === 0) return malformed('malformed-no-choice');
  if (choiceAnswers.length > 1) return malformed('malformed-multi-choice');
  const route = choiceAnswers[0];
  if (typeof route.choice !== 'string') return malformed('malformed-choice-missing');
  const probs = route.probabilities;
  if (!probs || typeof probs !== 'object') return malformed('malformed-choice-missing');
  if (!Object.prototype.hasOwnProperty.call(probs, route.choice)) return malformed('malformed-choice-missing');
  // Confidence of the CHOSEN option (T4: was max over ALL options, which let
  // an unchosen 0.9 speak for a chosen 0.05). Must be a real probability - a
  // string or NaN clears every `<` threshold comparison and auto-decides.
  const chosenProb = probs[route.choice];
  if (typeof chosenProb !== 'number' || !Number.isFinite(chosenProb) || chosenProb < 0 || chosenProb > 1)
    return malformed('malformed-probability');
  for (const v of Object.values(flags)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return malformed('malformed-noul');
  }
  if (Object.keys(flags).length === 0) return malformed('malformed-no-noul');

  const maxFlag = Object.keys(flags).length ? Math.max(...Object.values(flags)) : null;

  // --- the gate, in order: every step except flag-first escalates ---
  // Flag-first (T5, finding F-D): a flag over the cut still blocks any accept -
  // the choice can never override it - but the REWORK is JEV's RECOMMENDATION,
  // not a decision: the orchestrator reviews it (orchestrator CLAUDE.md: any
  // flag over 0.55 escalates to your own review). verdict stays 'rework' so
  // cascade's gateVerdict === 'rework' escalation keeps firing on a flag.
  if (maxFlag > flag) return { verdict: 'rework', decided_by: 'escalate', branch: 'flag-first', recommendation: 'rework', flags, maxFlag, chosenProb, topProb: chosenProb };
  if (chosenProb < abstain) return escalate('abstain', flags, maxFlag, chosenProb);
  if (Object.values(flags).some(v => v >= band[0] && v <= band[1]))
    return escalate('uncertain-band', flags, maxFlag, chosenProb);
  // Only a decisive route is a decision. 'other'/'none'/'none_fit'/'None'/any
  // unknown spelling means "none of these fit" - that is not a verdict.
  if (!decisive.includes(route.choice)) return escalate('non-decisive', flags, maxFlag, chosenProb);
  if (chosenProb < autoApply) return escalate('below-auto-apply', flags, maxFlag, chosenProb);
  return { verdict: route.choice, decided_by: 'jev', branch: 'confident', flags, maxFlag, chosenProb, topProb: chosenProb };
}

// Try each configured systemone provider in order. Every provider must speak
// the same protocol - a chat endpoint is NOT a substitute (see
// docs/superpowers/evidence/2026-10-04-openrouter-is-not-a-jev-fallback.md).
// `opts` (fetchImpl, timeoutMs, retries, breaker) is forwarded to askJev so
// the chain is testable without touching globalThis.fetch.
export async function askJevChain(state, questions, providers = [], opts = {}) {
  const { fetchImpl, timeoutMs, retries, breaker } = opts;
  const tried = [];
  for (const p of providers) {
    const r = await askJev(state, questions, {
      baseUrl: p.base_url, model: p.model, apiKey: process.env[p.api_key_env] ?? p.api_key,
      ...(fetchImpl !== undefined && { fetchImpl }),
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(retries !== undefined && { retries }),
      ...(breaker !== undefined && { breaker }),
    });
    if (r.ok) return { ...r, provider: p.base_url, tried };   // keep the trail even on success
    tried.push({ provider: p.base_url, reason: r.reason });
    if (r.fatal) return { ...r, tried };          // bad credential: do not fail over
  }
  return { ok: false, degraded: true, reason: tried[0]?.reason ?? 'no_providers', tried, action: 'orchestrator_review' };
}
