import test from 'node:test';
import assert from 'node:assert/strict';

import { askJev, askJevChain, gateVerdict, breakerStatus, resetBreaker } from './lib/jev.mjs';

// HERMETIC: every askJev call below gets an injected fetchImpl stub. No test in
// this file may touch the network, and none may depend on whether the live JEV
// service is up or down. As a tripwire, the global fetch is replaced with a
// function that records and throws - if any code path ever falls back to the
// real fetch, the final test fails.
let realFetchCalls = 0;
globalThis.fetch = async () => { realFetchCalls += 1; throw new Error('network access forbidden in jev-fallback.test.mjs'); };

const KEY = 'test-key-not-real';
const Q = {
  out_of_scope: { type: 'noul', instructions: 'Does the change touch files the spec did not authorise?' },
  route: { type: 'choice', instructions: 'Gate decision?', criteria: { accept: 'ok', rework: 'problem', other: 'none of these fit' } },
};

// Minimal Response double: askJev only reads status, ok and json().
function res(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
// A fetchImpl stub that replays a script of responses (or thrown errors) and
// counts calls. The last entry repeats once the script is exhausted.
function stub(...script) {
  const f = async (url, init) => {
    const step = script[Math.min(f.calls, script.length - 1)];
    f.calls += 1;
    f.lastInit = init;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, init);
    return step;
  };
  f.calls = 0;
  return f;
}
const OK_BODY = {
  model: 'jev-1-13-free',
  answers: {
    out_of_scope: { type: 'noul', noul: 0.05 },
    route: { type: 'choice', choice: 'accept', probabilities: { accept: 0.9, rework: 0.08, other: 0.02 }, confidence: 0.85 },
  },
};
const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test.beforeEach(() => resetBreaker());

// ---------------------------------------------------------------- askJev ----

test('askJev: 503 degrades to orchestrator_review and does not throw', async () => {
  const f = stub(res(503, {}));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'unavailable');
  assert.equal(r.action, 'orchestrator_review');
  assert.equal(f.calls, 1);
});

test('askJev: 5xx is retried once before degrading', async () => {
  const f = stub(res(502, {}), res(503, {}));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 1, fetchImpl: f });
  assert.equal(f.calls, 2);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'unavailable');
  assert.equal(r.action, 'orchestrator_review');
});

test('askJev: 5xx then 200 recovers on the retry', async () => {
  const f = stub(res(503, {}), res(200, OK_BODY));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 1, fetchImpl: f });
  assert.equal(f.calls, 2);
  assert.equal(r.ok, true);
});

test('askJev: thrown TimeoutError degrades with reason timeout', async () => {
  const f = stub(timeoutError());
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.action, 'orchestrator_review');
});

test('askJev: the real AbortSignal timeout path degrades with reason timeout', async () => {
  // A stub that never answers and only rejects when askJev's own signal fires.
  const f = stub((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, timeoutMs: 20, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'timeout');
});

test('askJev: thrown network error degrades with reason unreachable', async () => {
  const f = stub(new TypeError('fetch failed'), new TypeError('fetch failed'));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 1, fetchImpl: f });
  assert.equal(f.calls, 2);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.action, 'orchestrator_review');
});

for (const status of [401, 403]) {
  test(`askJev: HTTP ${status} is fatal (action stop, not degraded) and not retried`, async () => {
    const f = stub(res(status, {}));
    const r = await askJev('s', Q, { apiKey: KEY, retries: 2, fetchImpl: f });
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
    assert.equal(r.degraded, false);
    assert.equal(r.action, 'stop');
    assert.equal(r.reason, 'auth');
    assert.equal(f.calls, 1);
    assert.equal(breakerStatus().failures, 0, 'a bad credential is not an outage');
  });
}

test('askJev: 429 is retried, then degrades with reason rate_limited', async () => {
  const f = stub(res(429, {}));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 1, fetchImpl: f });   // one ~1s back-off
  assert.equal(f.calls, 2);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'rate_limited');
  assert.equal(r.action, 'orchestrator_review');
});

test('askJev: non-JSON body degrades with reason malformed', async () => {
  const f = stub({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'malformed');
  assert.equal(r.action, 'orchestrator_review');
});

test('askJev: JSON without answers degrades with reason malformed', async () => {
  const f = stub(res(200, { model: 'jev-1-13-free' }));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'malformed');
});

test('askJev: no API key degrades with reason auth and never calls fetch', async () => {
  const f = stub(res(200, OK_BODY));
  const r = await askJev('s', Q, { apiKey: '', fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'auth');
  assert.equal(r.action, 'orchestrator_review');
  assert.equal(f.calls, 0);
});

test('askJev: 200 with answers returns ok and sends the bearer key', async () => {
  const f = stub(res(200, OK_BODY));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(r.answers, OK_BODY.answers);
  assert.equal(f.lastInit.headers.Authorization, `Bearer ${KEY}`);
});

// --------------------------------------------------------------- breaker ----

test('breaker: 3 consecutive failures open it; the next call short-circuits without fetch', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 60000 };
  const f = stub(res(503, {}));
  for (let i = 1; i <= 3; i++) {
    const r = await askJev('s', Q, { apiKey: KEY, retries: 0, breaker: br, fetchImpl: f });
    assert.equal(r.reason, 'unavailable');
    assert.equal(breakerStatus().open, i === 3, `after failure ${i}`);
  }
  assert.equal(f.calls, 3);
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, breaker: br, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'circuit_open');
  assert.equal(r.action, 'orchestrator_review');
  assert.equal(f.calls, 3, 'an open breaker must not call fetch');
});

test('breaker: a success resets the failure count so failures must be consecutive', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 60000 };
  const f = stub(res(503, {}), res(503, {}), res(200, OK_BODY), res(503, {}), res(503, {}));
  for (let i = 0; i < 5; i++) await askJev('s', Q, { apiKey: KEY, retries: 0, breaker: br, fetchImpl: f });
  assert.equal(f.calls, 5);
  assert.equal(breakerStatus().failures, 2);
  assert.equal(breakerStatus().open, false);
});

test('breaker: after the cooldown a success closes it', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 1 };
  const fail = stub(res(503, {}));
  for (let i = 0; i < 3; i++) await askJev('s', Q, { apiKey: KEY, retries: 0, breaker: br, fetchImpl: fail });
  assert.ok(breakerStatus().failures >= 3);
  await new Promise(r => setTimeout(r, 10));   // let the 1ms cooldown lapse
  const ok = stub(res(200, OK_BODY));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, breaker: br, fetchImpl: ok });
  assert.equal(ok.calls, 1);
  assert.equal(r.ok, true);
  assert.deepEqual({ open: breakerStatus().open, failures: breakerStatus().failures }, { open: false, failures: 0 });
});

// ----------------------------------------------------------- gateVerdict ----

const answers = (noul, choice, probabilities) => ({
  ok: true,
  answers: {
    out_of_scope: { type: 'noul', noul },
    route: { type: 'choice', choice, probabilities, confidence: 0.8 },
  },
});

test('gateVerdict: a degraded askJev result escalates to orchestrator via fallback', async () => {
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: stub(res(503, {})) });
  const v = gateVerdict(r);
  assert.equal(v.verdict, 'orchestrator');
  assert.equal(v.decided_by, 'fallback');
  assert.equal(v.reason, 'unavailable');
});

test('gateVerdict: circuit_open, auth, timeout and malformed results also go to fallback, never auto-pass', () => {
  for (const reason of ['circuit_open', 'auth', 'timeout', 'malformed']) {
    const v = gateVerdict({ ok: false, degraded: true, reason, action: 'orchestrator_review' });
    assert.deepEqual([v.verdict, v.decided_by, v.reason], ['orchestrator', 'fallback', reason]);
  }
});

test('gateVerdict: confident accept with low flags is decided by JEV', () => {
  const v = gateVerdict(answers(0.05, 'accept', { accept: 0.9, rework: 0.08, other: 0.02 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['accept', 'jev', 'confident']);
});

// Run 20261007-1720 T5-deletion-policy (finding F-D): orchestrator CLAUDE.md
// says any flag over 0.55 escalates to the orchestrator's own review, but the
// flag-first branch used to return decided_by 'jev' - JEV auto-deciding the
// rework. Now verdict 'rework' is JEV's RECOMMENDATION (decided_by 'escalate'):
// the flag still blocks any accept (the choice can never override it), but the
// orchestrator decides. verdict stays 'rework' so cascade's
// gateVerdict === 'rework' escalation keeps working.
test('gateVerdict: a flag over 0.55 -> verdict rework as a RECOMMENDATION, decided_by escalate (F-D)', () => {
  const v = gateVerdict(answers(0.56, 'accept', { accept: 0.95, rework: 0.05, other: 0 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['rework', 'escalate', 'flag-first']);
  assert.equal(v.recommendation, 'rework', 'JEV recommends rework; the orchestrator decides');
  assert.equal(v.maxFlag, 0.56, 'the flag value is carried as evidence');
  assert.equal(v.chosenProb, 0.95);
  assert.notEqual(v.verdict, 'accept', 'the flag blocks any accept - the choice cannot override it');
});

test('gateVerdict: a 0.9 flag with a confident accept -> rework / escalate / flag-first, never accept', () => {
  const v = gateVerdict(answers(0.9, 'accept', { accept: 0.99, rework: 0.01, other: 0 }));
  assert.equal(v.verdict, 'rework');
  assert.equal(v.decided_by, 'escalate');
  assert.equal(v.branch, 'flag-first');
  assert.equal(v.recommendation, 'rework');
});

test('gateVerdict: top probability under 0.6 abstains to the orchestrator', () => {
  const v = gateVerdict(answers(0.05, 'accept', { accept: 0.55, rework: 0.4, other: 0.05 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'abstain']);
});

test('gateVerdict: a flag in the 0.4-0.55 band escalates as uncertain-band', () => {
  const v = gateVerdict(answers(0.45, 'accept', { accept: 0.9, rework: 0.1, other: 0 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'uncertain-band']);
});

test("gateVerdict: a confident 'other' (none of these fit) escalates as non-decisive, it is not a decision", () => {
  const v = gateVerdict(answers(0.05, 'other', { accept: 0.05, rework: 0.05, other: 0.9 }));
  assert.equal(v.verdict, 'orchestrator');
  assert.equal(v.decided_by, 'escalate');
  assert.equal(v.branch, 'non-decisive');
  assert.equal(v.topProb, 0.9);
  assert.equal(v.chosenProb, 0.9);
});

test("gateVerdict: flag-first still wins over a confident 'other'", () => {
  const v = gateVerdict(answers(0.9, 'other', { accept: 0, rework: 0.1, other: 0.9 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['rework', 'escalate', 'flag-first']);
});

test("gateVerdict: a low-confidence 'other' still escalates", () => {
  const v = gateVerdict(answers(0.05, 'other', { accept: 0.3, rework: 0.2, other: 0.5 }));
  assert.equal(v.verdict, 'orchestrator');
  assert.equal(v.decided_by, 'escalate');
});

test('gateVerdict: no choice-type answer at all escalates (malformed-no-choice), without throwing', () => {
  const v = gateVerdict({ ok: true, answers: { out_of_scope: { type: 'noul', noul: 0.05 } } });
  assert.equal(v.verdict, 'orchestrator');
  assert.equal(v.decided_by, 'escalate');
  assert.equal(v.branch, 'malformed-no-choice');
});

test('gateVerdict: an empty answers object escalates (malformed-no-choice; that check runs first) without throwing', () => {
  const v = gateVerdict({ ok: true, answers: {} });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-no-choice']);
});

test('gateVerdict: an ok result with no answers key at all escalates without throwing', () => {
  const v = gateVerdict({ ok: true });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-no-choice']);
});

test('gateVerdict: no noul answers at all escalates (malformed-no-noul; flag-first cannot run)', () => {
  const v = gateVerdict({ ok: true, answers: { route: { type: 'choice', choice: 'accept', probabilities: { accept: 0.9, other: 0.1 } } } });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-no-noul']);
});

// --------------------------------- T4 hardening: reproduced defects, now fixed ----
// Each of these is a verbatim reproduction from the T3-verify report of this
// run (fleet/runs/20261007-1009-fleet-followups/reports/T3-verify.md). All of
// them auto-decided on garbage before T4; every one must now escalate.

test('T4 reproduce 1: chosen accept @0.05 with other @0.9 must escalate, not decide accept', () => {
  // topProb used to be the max over ALL options (0.9, for a DIFFERENT option),
  // sailing past the abstain gate on an unchosen route.
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: 0.1 },
      route: { type: 'choice', choice: 'accept', probabilities: { accept: 0.05, rework: 0.05, other: 0.9 } },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'abstain']);
  assert.equal(v.chosenProb, 0.05);
});

test("T4 reproduce 2: a 'None' route is not in the decisive list - escalate, never verdict 'None'", () => {
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: 0.1 },
      route: { type: 'choice', choice: 'None', probabilities: { accept: 0.05, None: 0.95 } },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'non-decisive']);
});

test('T4 reproduce 3: a choice answer with no `choice` field escalates (malformed-choice-missing), never decides undefined', () => {
  const v = gateVerdict({ ok: true, answers: { route: { type: 'choice', probabilities: { accept: 0.9, other: 0.1 } } } });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-choice-missing']);
  assert.notEqual(v.decided_by, 'jev');
});

test('T4 reproduce 4: a NaN noul escalates (malformed-noul), it is not a flag value', () => {
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: NaN },
      route: { type: 'choice', choice: 'accept', probabilities: { accept: 0.95, rework: 0.05 } },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

// ------------------------------------------ T4 hardening: malformed inputs ----
// Anything that is not a well-formed gate answer escalates as a DISTINCT
// malformed-* branch - the orchestrator sees WHY the gate could not run,
// which is a different situation from abstention.

test('gateVerdict: choice names an option absent from probabilities (malformed-choice-missing)', () => {
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: 0.1 },
      route: { type: 'choice', choice: 'accept', probabilities: { rework: 0.6, other: 0.4 } },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-choice-missing']);
});

test('gateVerdict: a non-finite noul value (Infinity) escalates (malformed-noul)', () => {
  const v = gateVerdict(answers(Infinity, 'accept', { accept: 0.9, other: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

test('gateVerdict: a noul above 1 escalates (malformed-noul; a noul is a 0-1 probability)', () => {
  const v = gateVerdict(answers(1.5, 'accept', { accept: 0.9, other: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

test('gateVerdict: a noul below 0 escalates (malformed-noul)', () => {
  const v = gateVerdict(answers(-0.1, 'accept', { accept: 0.9, other: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

test('gateVerdict: a string noul value escalates (malformed-noul)', () => {
  const v = gateVerdict(answers('high', 'accept', { accept: 0.9, other: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

test('gateVerdict: a null noul value escalates (malformed-noul)', () => {
  const v = gateVerdict(answers(null, 'accept', { accept: 0.9, other: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-noul']);
});

test('gateVerdict: two choice answers escalate (malformed-multi-choice; the route is ambiguous)', () => {
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: 0.1 },
      route: { type: 'choice', choice: 'accept', probabilities: { accept: 0.9, other: 0.1 } },
      route2: { type: 'choice', choice: 'rework', probabilities: { rework: 0.9, other: 0.1 } },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-multi-choice']);
});

test('gateVerdict: a non-object probabilities map escalates (malformed-choice-missing)', () => {
  const v = gateVerdict({
    ok: true,
    answers: {
      f: { type: 'noul', noul: 0.1 },
      route: { type: 'choice', choice: 'accept' },
    },
  });
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-choice-missing']);
});

test('gateVerdict: a non-numeric chosen probability escalates (malformed-probability), never decides confident', () => {
  // 'yes' < 0.6 is false, 'yes' < 0.8 is false - a string probability would
  // clear every threshold comparison and auto-decide.
  const v = gateVerdict(answers(0.05, 'accept', { accept: 'yes', rework: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-probability']);
});

test('gateVerdict: a NaN chosen probability escalates (malformed-probability)', () => {
  const v = gateVerdict(answers(0.05, 'accept', { accept: NaN, rework: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-probability']);
});

test('gateVerdict: a chosen probability above 1 escalates (malformed-probability)', () => {
  const v = gateVerdict(answers(0.05, 'accept', { accept: 1.4, rework: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'malformed-probability']);
});

test('gateVerdict: malformed-noul reports WHICH flag was garbage, as evidence', () => {
  const v = gateVerdict(answers(NaN, 'accept', { accept: 0.9, other: 0.1 }));
  assert.equal(v.branch, 'malformed-noul');
  assert.deepEqual(Object.keys(v.flags), ['out_of_scope']);
});

// -------------------------------------------- T4 hardening: new gate order ----

test('gateVerdict: confidence is the CHOSEN option probability, not the max of all', () => {
  // chosenProb 0.7 clears abstain 0.6, sits outside the flag band, is decisive,
  // but is under autoApply 0.8 -> below-auto-apply, and topProb mirrors it.
  const v = gateVerdict(answers(0.05, 'accept', { accept: 0.7, rework: 0.1, other: 0.2 }));
  assert.equal(v.chosenProb, 0.7);
  assert.equal(v.topProb, 0.7, 'topProb now mirrors the chosen-option probability');
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'below-auto-apply']);
});

test('gateVerdict: chosen prob 0.85 accept is decided by JEV (autoApply 0.8 cleared)', () => {
  const v = gateVerdict(answers(0.05, 'accept', { accept: 0.85, rework: 0.1, other: 0.05 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['accept', 'jev', 'confident']);
  assert.equal(v.chosenProb, 0.85);
});

test('gateVerdict: decisive route "verified" follows the choice', () => {
  const v = gateVerdict(answers(0.05, 'verified', { verified: 0.9, rework: 0.1 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['verified', 'jev', 'confident']);
});

test('gateVerdict: NON-decisive route "escalate" escalates even at 0.99', () => {
  const v = gateVerdict(answers(0.05, 'escalate', { escalate: 0.99, accept: 0.01 }));
  assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'non-decisive']);
});

test('gateVerdict: "none" and "none_fit" route spellings also escalate as non-decisive', () => {
  for (const c of ['none', 'none_fit']) {
    const v = gateVerdict(answers(0.05, c, { [c]: 0.9, accept: 0.1 }));
    assert.deepEqual([v.verdict, v.decided_by, v.branch], ['orchestrator', 'escalate', 'non-decisive'], c);
  }
});

test('gateVerdict: malformed checks run BEFORE flag-first (a bad noul beats a high flag)', () => {
  const v = gateVerdict(answers(NaN, 'accept', { accept: 0.9, other: 0.1 }));
  assert.equal(v.branch, 'malformed-noul', 'malformed is checked first, before flag-first');
});

// ----------------------------------------------------- fixed in T4 (was todo) ----

test('askJev: a JSON `null` body degrades as malformed, it does not throw', async () => {
  const f = stub(res(200, null));
  const r = await askJev('s', Q, { apiKey: KEY, retries: 0, fetchImpl: f });
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'malformed');
  assert.equal(r.action, 'orchestrator_review');
});

test('askJevChain: a breaker opened by the primary does not block a healthy secondary', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 60000 };
  const dead = stub(res(503, {}));
  for (let i = 0; i < 3; i++) {
    await askJev('s', Q, { baseUrl: 'https://primary.invalid', apiKey: KEY, retries: 0, breaker: br, fetchImpl: dead });
  }
  assert.equal(breakerStatus('https://primary.invalid').open, true, 'the primary breaker is open');

  // A URL-routed fetchImpl forwarded by askJevChain: primary 503, secondary OK.
  let secondaryCalls = 0;
  const routed = stub((url) => {
    if (url === 'https://secondary.invalid') { secondaryCalls += 1; return res(200, OK_BODY); }
    return res(503, {});
  });
  const r = await askJevChain('s', Q, [
    { base_url: 'https://primary.invalid', model: 'm', api_key: KEY },
    { base_url: 'https://secondary.invalid', model: 'm', api_key: KEY },
  ], { fetchImpl: routed, breaker: br });
  assert.equal(secondaryCalls, 1, 'the secondary provider was contacted');
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'https://secondary.invalid');
});

test('askJevChain: a secondary success does not reset the primary breaker failures', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 60000 };
  // Two primary failures (one short of opening), then a healthy secondary run.
  const dead = stub(res(503, {}));
  await askJev('s', Q, { baseUrl: 'https://primary.invalid', apiKey: KEY, retries: 0, breaker: br, fetchImpl: dead });
  await askJev('s', Q, { baseUrl: 'https://primary.invalid', apiKey: KEY, retries: 0, breaker: br, fetchImpl: dead });

  const ok = stub(res(200, OK_BODY));
  const r = await askJevChain('s', Q, [
    { base_url: 'https://secondary.invalid', model: 'm', api_key: KEY },
  ], { fetchImpl: ok, breaker: br });
  assert.equal(r.ok, true);
  assert.equal(breakerStatus('https://primary.invalid').failures, 2, 'the secondary success left the primary count at 2');
});

test('askJevChain: forwards timeoutMs, retries and breaker so it is testable without globalThis.fetch', async () => {
  // retries 0 and a 503 primary: exactly one primary call, then failover.
  const routed = stub((url) => url === 'https://secondary.invalid' ? res(200, OK_BODY) : res(503, {}));
  const r = await askJevChain('s', Q, [
    { base_url: 'https://primary.invalid', model: 'm', api_key: KEY },
    { base_url: 'https://secondary.invalid', model: 'm', api_key: KEY },
  ], { retries: 0, timeoutMs: 5000, breaker: { failures_to_open: 5, cooldown_ms: 60000 }, fetchImpl: routed });
  assert.equal(r.ok, true);
  assert.equal(r.tried.length, 1, 'with retries 0 the primary was tried exactly once');
});

test('askJevChain: breakerStatus(provider) reports one provider; resetBreaker clears all', async () => {
  const br = { failures_to_open: 3, cooldown_ms: 60000 };
  const dead = stub(res(503, {}));
  await askJev('s', Q, { baseUrl: 'https://a.invalid', apiKey: KEY, retries: 0, breaker: br, fetchImpl: dead });
  await askJev('s', Q, { baseUrl: 'https://b.invalid', apiKey: KEY, retries: 0, breaker: br, fetchImpl: dead });
  const a = breakerStatus('https://a.invalid');
  const b = breakerStatus('https://b.invalid');
  assert.equal(a.failures, 1);
  assert.equal(b.failures, 1);
  resetBreaker();
  assert.deepEqual(breakerStatus('https://a.invalid'), { open: false, failures: 0, openUntil: 0 });
  assert.deepEqual(breakerStatus('https://b.invalid'), { open: false, failures: 0, openUntil: 0 });
});

// ------------------------------------------------------------- hermeticity ----

test('hermetic: no test fell through to the real global fetch', () => {
  assert.equal(realFetchCalls, 0);
});
