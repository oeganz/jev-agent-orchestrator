// Tests for the five-axis scorecard. Hermetic: fixture run dirs under a
// tempdir, no network, no live Orca, no model. Exercises every axis plus the
// edge cases the spec calls out explicitly: missing reports, unpriced/priced
// models, zero-token rows, missing milestones.json, malformed rows, and the
// longest-key-first substring match for model_rates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  score, costAxis, timeAxis, priceAxis, qualityAxis, errorAxis,
  pickRate, isPriced, print,
} from './lib/score.mjs';

// ---------------------------------------------------------------------------
// Fixture builder. Each test that needs a run dir gets a fresh tmpdir; the
// shape below matches what `task row may carry 'tokens' and 'model'` plus a
// gates.jsonl with verdicts, error_class, and follow_ups. milestones.json is
// OPTIONAL (the case the spec asks us to exercise).
// ---------------------------------------------------------------------------
function makeRun({ tokens, models, verdicts, errorClasses, followUps, includeMilestones, includeReports, runStatus } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'score-test-'));
  const dir = join(root, 'run');
  mkdirSync(dir);
  mkdirSync(join(dir, 'reports'), { recursive: true });

  const tasks = [];
  const dispatches = [
    { task_id: 'T1-build', role: 'engineer', offset: 0, gateMinutes: 2 },
    { task_id: 'T2-verify', role: 'tester', offset: 5, gateMinutes: 3, verdict: 'verified' },
    { task_id: 'T1r-fix', role: 'engineer', offset: 12, gateMinutes: 30, reworkOf: 'T1-build' },
  ];
  const baseTs = '2026-10-08T12:00:00';
  for (let i = 0; i < dispatches.length; i++) {
    const d = dispatches[i];
    const row = {
      ts: shift(baseTs, d.offset * 60),
      task_id: d.task_id,
      role: d.role,
      size_est_min: 15,
      base_sha: '373bf6b',
    };
    if (d.reworkOf) row.rework_of = d.reworkOf;
    if (tokens && tokens[i] != null) row.tokens = tokens[i];
    if (models && models[i] != null) row.model = models[i];
    tasks.push(JSON.stringify(row));
  }
  writeFileSync(join(dir, 'tasks.jsonl'), tasks.join('\n') + '\n');

  const gates = [];
  if (verdicts && verdicts.length) {
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i];
      const d = dispatches[i] || dispatches[0];
      const g = {
        ts: shift(baseTs, d.offset * 60 + d.gateMinutes),
        gate: v.gate || 'G3',
        task_id: d.task_id,
        verdict: v.verdict || 'accept',
        decided_by: 'orchestrator',
      };
      if (v.error_class) g.error_class = v.error_class;
      if (v.follow_ups && followUps) g.follow_ups = followUps;
      gates.push(JSON.stringify(g));
    }
  }
  writeFileSync(join(dir, 'gates.jsonl'), gates.join('\n') + '\n');

  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    objective: 'test',
    status: runStatus || 'completed',
  }));

  if (includeMilestones) {
    writeFileSync(join(dir, 'milestones.json'), JSON.stringify({
      milestones: [{ id: 'M1', title: 't', tasks: ['T1-build'], acceptance: ['echo ok'], est_min: 15 }],
    }));
  }

  if (includeReports !== false) {
    writeFileSync(join(dir, 'reports', 'T1-build.md'), '# T1\nok\n');
    writeFileSync(join(dir, 'reports', 'T2-verify.md'), '# T2\nok\n');
  }

  return { root, dir };
}

function shift(baseTs, offsetMin) {
  const d = new Date(baseTs);
  d.setMinutes(d.getMinutes() + offsetMin);
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'score-test-'));
  try { return fn(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ===========================================================================
// pickRate / isPriced - the substring matching rules the spec calls out
// ===========================================================================
test('pickRate: longest-key wins (claude-opus-5-5 beats claude-opus beats claude)', () => {
  const rates = { 'claude': 1, 'claude-opus': 2, 'claude-opus-5-5': 3 };
  assert.equal(pickRate('claude-opus-5-5-20251001', rates).rate, 3);
  assert.equal(pickRate('claude-opus-2-0', rates).rate, 2);
  assert.equal(pickRate('claude-haiku-1', rates).rate, 1);
});
test('pickRate: returns null when no key matches', () => {
  assert.equal(pickRate('gpt-4o', { claude: 1 }), null);
});
test('pickRate: returns null when model is empty or missing', () => {
  assert.equal(pickRate('', { claude: 1 }), null);
  assert.equal(pickRate(null, { claude: 1 }), null);
  assert.equal(pickRate(undefined, { claude: 1 }), null);
});
test('pickRate: rates=0 still resolves the key (the caller decides UNPRICED)', () => {
  const r = pickRate('claude-opus-5-5', { 'claude-opus-5-5': 0 });
  assert.deepEqual({ key: r.key, rate: r.rate }, { key: 'claude-opus-5-5', rate: 0 });
});
test('isPriced: false when map is missing or all-zero; true when any entry > 0', () => {
  assert.equal(isPriced({}), false);
  assert.equal(isPriced({ 'claude-opus-5-5': 0 }), false);
  assert.equal(isPriced({ 'claude-opus-5-5': 0.001 }), true);
});

// ===========================================================================
// COMPLETE RUN - all five axes compute from a well-formed run dir
// ===========================================================================
test('score: complete run produces every axis with shaped output (no crashes)', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir); mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'tasks.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:00:00', task_id: 'T1', role: 'engineer', tokens: 100000, model: 'claude-sonnet-1-2' }) + '\n' +
      JSON.stringify({ ts: '2026-10-08T12:30:00', task_id: 'T2', role: 'tester', tokens: 50000, model: 'claude-haiku-1' }) + '\n');
    writeFileSync(join(dir, 'gates.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:31:00', gate: 'G3', task_id: 'T2', verdict: 'verified', decided_by: 'orchestrator', error_class: 'worker-defect' }) + '\n');
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ status: 'completed' }));
    writeFileSync(join(dir, 'milestones.json'), JSON.stringify({ milestones: [{ id: 'M1', tasks: ['T1', 'T2'] }] }));

    const rates = { 'claude-sonnet-1-2': 3, 'claude-haiku-1': 1 };
    const s = score(dir, { rates });
    assert.equal(s.cost.worker_tokens, 150000);
    assert.equal(s.cost.worker_rows_with_tokens, 2);
    assert.ok(s.time.totalMs > 0, 'timing axis must report positive wall clock');
    assert.equal(s.price.priced, true);
    assert.ok(s.price.priced_usd > 0, 'priced_usd must be a real number when rates > 0');
    assert.equal(s.price.lines.length, 2);
    assert.equal(s.quality.verdict_counts.verified, 1);
    assert.equal(s.quality.rework_count, 0);
    assert.equal(s.quality.rework_deltas, 0);
    assert.equal(s.error_rate.by_class['worker-defect'], 1);
  });
});

// ===========================================================================
// COST - including zero-token rows (spec asks for this)
// ===========================================================================
test('costAxis: a row with tokens=0 still counts as a recorded row', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tasks.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:00:00', task_id: 'T1', tokens: 0, model: 'claude' }) + '\n' +
      JSON.stringify({ ts: '2026-10-08T12:30:00', task_id: 'T2', tokens: 75000, model: 'claude' }) + '\n');
    const c = costAxis(dir);
    assert.equal(c.worker_tokens, 75000, 'zero-token rows add 0 to the sum but still count as recorded');
    assert.equal(c.worker_rows_with_tokens, 2);
  });
});
test('costAxis: tasks with no `tokens` field leave worker_tokens at 0 and explain why', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tasks.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:00:00', task_id: 'T1' }) + '\n');
    const c = costAxis(dir);
    assert.equal(c.worker_tokens, 0);
    assert.equal(c.worker_rows_with_tokens, 0);
    assert.match(c.note, /unmeasured/);
  });
});

// ===========================================================================
// PRICE - UNPRICED vs priced, with the substring rule
// ===========================================================================
test('priceAxis: missing model_rates -> priced=false, UNPRICED note, no dollar figure', () => {
  const r = makeRun({
    tokens: [100000, 50000, 0],
    models: ['claude-sonnet-1-2', 'claude-haiku-1', 'claude-sonnet-1-2'],
    verdicts: [{ gate: 'G3', verdict: 'verified' }],
  });
  try {
    const p = priceAxis(r.dir, undefined);
    assert.equal(p.priced, false);
    assert.equal(p.priced_usd, 0);
    assert.equal(p.unpriced_tokens, 150000);
    assert.match(p.note, /UNPRICED/);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('priceAxis: rates-all-zero (placeholder) -> UNPRICED, unpriced_tokens counted, no fake dollars', () => {
  const r = makeRun({
    tokens: [100000, 50000, 0],
    models: ['claude-sonnet-1-2', 'claude-haiku-1', 'claude-sonnet-1-2'],
    verdicts: [{ gate: 'G3', verdict: 'verified' }],
  });
  try {
    const p = priceAxis(r.dir, { 'claude-sonnet-1-2': 0, 'claude-haiku-1': 0 });
    assert.equal(p.priced, false);
    assert.equal(p.priced_usd, 0);
    assert.equal(p.unpriced_tokens, 150000);
    assert.match(p.note, /UNPRICED/);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('priceAxis: priced when at least one rate > 0; longest-key wins; dollars computed', () => {
  const r = makeRun({
    tokens: [1_000_000, 500_000],
    models: ['claude-opus-5-5-20251001', 'claude-haiku-1'],
    verdicts: [{ gate: 'G3', verdict: 'verified' }],
  });
  try {
    const rates = {
      'claude': 0,                                      // caught by the broad key
      'claude-opus-5-5': 9,                              // catches the opus line first
      'claude-haiku-1': 1,                               // catches the haiku line
    };
    const p = priceAxis(r.dir, rates);
    assert.equal(p.priced, true);
    // 1M tokens @ $9/M + 0.5M tokens @ $1/M = $9.5
    assert.equal(p.priced_usd.toFixed(4), '9.5000');
    assert.equal(p.priced_tokens, 1_500_000);
    assert.equal(p.unpriced_tokens, 0);
    assert.equal(p.lines.length, 2);
    assert.equal(p.lines[0].rate_key, 'claude-opus-5-5');
    assert.equal(p.lines[1].rate_key, 'claude-haiku-1');
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('priceAxis: tokens without a model id go to unknown_model_tokens, not priced', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tasks.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:00:00', task_id: 'T1', tokens: 800000 }) + '\n' +
      JSON.stringify({ ts: '2026-10-08T12:30:00', task_id: 'T2', tokens: 200000, model: 'claude-haiku-1' }) + '\n');
    const p = priceAxis(dir, { 'claude-haiku-1': 1 });
    assert.equal(p.unknown_model_tokens, 800000);
    assert.equal(p.priced_tokens, 200000);
  });
});

// ===========================================================================
// QUALITY - verdicts, rework count, deltas, follow-ups, missing verdicts
// ===========================================================================
test('qualityAxis: counts verdicts, separates rework_deltas from full retries', () => {
  const r = makeRun({ verdicts: [{ verdict: 'accept' }, { verdict: 'rework-needed' }, { verdict: 'verified' }] });
  try {
    const q = qualityAxis(r.dir);
    assert.equal(q.verdict_counts.accept, 1);
    assert.equal(q.verdict_counts['rework-needed'], 1);
    assert.equal(q.verdict_counts.verified, 1);
    assert.equal(q.rework_count, 1);
    assert.equal(q.rework_deltas, 1);
    assert.equal(q.last_g3_verdict, 'verified');
    assert.equal(q.final_verdict, 'completed');
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('qualityAxis: follow-ups gathered across gate rows', () => {
  const r = makeRun({
    verdicts: [
      { gate: 'G2', verdict: 'accept' },
      { gate: 'G3', verdict: 'verified', follow_ups: true },
    ],
    followUps: ['repoint LG-27', 'add prose carve-out'],
  });
  try {
    const q = qualityAxis(r.dir);
    assert.deepEqual(q.follow_ups, ['repoint LG-27', 'add prose carve-out']);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('qualityAxis: missing gates.jsonl -> empty counts, no throw, honest note', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'tasks.jsonl'), JSON.stringify({ ts: '2026-10-08T12:00:00', task_id: 'T1' }) + '\n');
    const q = qualityAxis(dir);
    assert.deepEqual(q.verdict_counts, {});
    assert.match(q.note, /no gates/);
  });
});

// ===========================================================================
// ERROR RATE - missing error_class is NOT silently defaulted to 0
// ===========================================================================
test('errorAxis: rows without error_class produce `not recorded`, no fake count', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'gates.jsonl'),
      JSON.stringify({ ts: '2026-10-08T12:30:00', gate: 'G2', task_id: 'T1', verdict: 'accept', decided_by: 'orchestrator' }) + '\n' +
      JSON.stringify({ ts: '2026-10-08T13:00:00', gate: 'G3', task_id: 'T2', verdict: 'verified', decided_by: 'orchestrator' }) + '\n');
    const e = errorAxis(dir);
    assert.equal(e.recorded_rows, 0);
    assert.equal(e.rows_without_error_class, 2);
    assert.deepEqual(e.by_class, {});
    assert.match(e.note, /not recorded/);
  });
});
test('errorAxis: known vocabulary is grouped; spec-gap and orchestrator count separately', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    const gate = (extra) => JSON.stringify({
      ts: '2026-10-08T12:30:00', gate: 'G2', task_id: 'T1',
      verdict: 'note', decided_by: 'orchestrator', ...extra,
    });
    writeFileSync(join(dir, 'gates.jsonl'),
      gate({ error_class: 'spec-gap' }) + '\n' +
      gate({ error_class: 'orchestrator' }) + '\n' +
      gate({ error_class: 'worker-protocol' }) + '\n' +
      gate({ error_class: 'spec-gap' }) + '\n' +
      JSON.stringify({ ts: '2026-10-08T12:31:00', gate: 'G3', task_id: 'T2', verdict: 'verified', decided_by: 'orchestrator' }) + '\n');
    const e = errorAxis(dir);
    assert.equal(e.by_class['spec-gap'], 2);
    assert.equal(e.by_class['orchestrator'], 1);
    assert.equal(e.by_class['worker-protocol'], 1);
    assert.equal(e.recorded_rows, 4);
    assert.equal(e.rows_without_error_class, 1);
  });
});
test('errorAxis: malformed JSON line in gates.jsonl is dropped, no throw', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    writeFileSync(join(dir, 'gates.jsonl'),
      'not-json-at-all\n' +
      JSON.stringify({ ts: '2026-10-08T12:30:00', gate: 'G2', task_id: 'T1', verdict: 'note', decided_by: 'orchestrator', error_class: 'orchestrator' }) + '\n' +
      '{not really json}\n');
    const e = errorAxis(dir);
    assert.equal(e.by_class['orchestrator'], 1, 'the one valid row should be counted');
    assert.equal(e.recorded_rows, 1);
  });
});

// ===========================================================================
// Missing reports / missing milestones must not crash quality or the score
// ===========================================================================
test('qualityAxis: missing reports/ does not change axis shape', () => {
  const r = makeRun({ verdicts: [{ verdict: 'verified' }], includeReports: false });
  try {
    const q = qualityAxis(r.dir);
    assert.equal(q.verdict_counts.verified, 1);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
test('score: missing milestones.json -> score still returns, no throw', () => {
  const r = makeRun({ verdicts: [{ verdict: 'verified' }], includeMilestones: false });
  try {
    const s = score(r.dir, {});
    assert.ok(s.cost, 'all axes present');
    assert.ok(s.time, 'all axes present');
    assert.ok(s.price, 'all axes present');
    assert.ok(s.quality, 'all axes present');
    assert.ok(s.error_rate, 'all axes present');
    assert.equal(s.price.priced, false);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

// ===========================================================================
// Printer must run without throwing, even on the most-degenerate input
// ===========================================================================
test('print: does not throw on an empty/degenerate run dir', () => {
  withTmp((root) => {
    const dir = join(root, 'run');
    mkdirSync(dir);
    const s = score(dir, {});
    // Console capture is fiddly in node:test; just confirm print does not throw.
    assert.doesNotThrow(() => print('empty-run', s));
  });
});
