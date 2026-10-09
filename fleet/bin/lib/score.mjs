// Five-axis scorecard for a single run (cost, time, price, quality, error rate).
// Reads the run store (run.json, tasks.jsonl, gates.jsonl, milestones.json if
// present) and never throws on a malformed row - the orchestrator can re-run
// this at any point and a half-written gate cannot break it.
//
// Cost / price / quality / error rate are derived here; time reuses
// lib/timing.mjs.analyse() so both views stay in lockstep.
//
// Model rates come from fleet/config.json -> model_rates, a substring -> usd
// per 1M tokens map. Match longest-key-wins so a more specific id (e.g.
// "claude-opus-5-5") beats a broader one (e.g. "claude"). When ALL rates are
// 0 (or the map is missing) the price axis is reported UNPRICED instead of a
// invented dollar figure.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { analyse } from './timing.mjs';

const jl = (p) => existsSync(p)
  ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
  : [];
const rj = (p) => existsSync(p) ? (() => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } })() : null;

// A row is well-formed enough to count if it has a ts and a verdict string -
// rows that miss either are recorded as malformed (and counted, not thrown on).
function isGateRow(g) { return !!(g && typeof g === 'object' && g.ts && typeof g.verdict === 'string'); }

// ---------------------------------------------------------------------------
// RATE MATCHING
// ---------------------------------------------------------------------------
// Sorted longest-key-first so 'claude-opus-5-5' beats 'claude-opus' beats
// 'claude'. The first key whose substring appears in the model id wins.
// Returns null for "no rule matched this model" - distinct from "rule says 0"
// (which is the UNPRICED placeholder).
export function pickRate(model, rates) {
  if (!model || !rates) return null;
  const keys = Object.keys(rates || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) if (!k) continue;
  for (const k of keys) {
    if (model.includes(k)) return { key: k, rate: rates[k] };
  }
  return null;
}

// Any rate > 0 across the map makes the axis priced; otherwise it's UNPRICED.
// This is the signal we print and the one tests assert against.
export function isPriced(rates) {
  if (!rates) return false;
  return Object.values(rates).some((v) => typeof v === 'number' && v > 0);
}

// ---------------------------------------------------------------------------
// AXIS 1 - COST (tokens actually spent, per dispatch). Tasks carry optional
// `tokens` (subagent usage total) and `model`. Workers sum; orchestrator
// tokens are NOT per-run meterable, we say so in the output.
// ---------------------------------------------------------------------------
export function costAxis(runDir) {
  const tasks = jl(join(runDir, 'tasks.jsonl'));
  let workerTokens = 0, workerRows = 0;
  const perTask = [];
  for (const t of tasks) {
    const tok = typeof t.tokens === 'number' ? t.tokens : null;
    perTask.push({ task_id: t.task_id, tokens: tok, model: t.model || null, role: t.role || null });
    if (tok != null) { workerTokens += tok; workerRows++; }
  }
  return {
    worker_tokens: workerTokens,
    worker_rows_with_tokens: workerRows,
    worker_rows_total: tasks.length,
    per_task: perTask,
    note: workerRows === 0
      ? 'no tasks.jsonl rows recorded a `tokens` field for this run - cost is unmeasured at the run level'
      : null,
  };
}

// ---------------------------------------------------------------------------
// AXIS 2 - TIME. Delegated to timing.analyse() (do not duplicate the phase
// math). A missing dispatch row for a gate verdict is an instrumentation gap.
// ---------------------------------------------------------------------------
export function timeAxis(runDir) {
  const a = analyse(runDir);
  return {
    totalMs: a.totalMs,
    phases: a.phases,
    events: a.events,
    instrumentation_gaps: a.missing,
    missing_data: a.missing === true,
  };
}

// ---------------------------------------------------------------------------
// AXIS 3 - PRICE. Apply rates from config.json -> model_rates. All-zero rates
// -> axis reports UNPRICED, never a dollar figure.
// ---------------------------------------------------------------------------
export function priceAxis(runDir, rates) {
  const tasks = jl(join(runDir, 'tasks.jsonl'));
  const lines = [];
  let pricedTokens = 0, unpricedTokens = 0, unknownModelTokens = 0;
  let pricedUsd = 0;
  let anyPriced = false;
  for (const t of tasks) {
    const tok = typeof t.tokens === 'number' ? t.tokens : null;
    if (tok == null) continue;
    const m = t.model || '';
    const r = pickRate(m, rates || {});
    if (!m) { unknownModelTokens += tok; continue; }
    if (!r) { unpricedTokens += tok; continue; }
    if (r.rate <= 0) { unpricedTokens += tok; continue; }
    anyPriced = true;
    // rate is USD per 1M tokens; convert.
    const usd = (tok / 1_000_000) * r.rate;
    pricedUsd += usd;
    pricedTokens += tok;
    lines.push({ task_id: t.task_id, model: m, rate_key: r.key, rate: r.rate, tokens: tok, usd });
  }
  const priced = isPriced(rates || {}) && anyPriced;
  return {
    priced: priced,
    priced_tokens: pricedTokens,
    priced_usd: pricedUsd,
    unpriced_tokens: unpricedTokens,
    unknown_model_tokens: unknownModelTokens,
    lines,
    note: !priced ? 'UNPRICED (set model_rates in fleet/config.json)' : null,
  };
}

// ---------------------------------------------------------------------------
// AXIS 4 - QUALITY. From gates.jsonl: count accept / rework / escalate /
// abstain by verdict string; final verdict from run.json + last G3; reworks
// counted, separating true deltas (rows with rework_of) from fresh dispatches.
// ---------------------------------------------------------------------------
export function qualityAxis(runDir) {
  const gates = jl(join(runDir, 'gates.jsonl')).filter(isGateRow);
  const tasks = jl(join(runDir, 'tasks.jsonl'));
  const counts = {};
  for (const g of gates) counts[g.verdict] = (counts[g.verdict] || 0) + 1;
  const reworkCount = (counts['rework-needed'] || 0) + (counts['rework'] || 0);
  // Rework split: "true" rework is a task row with rework_of set.
  const reworkDeltas = tasks.filter((t) => t && t.rework_of).length;
  // Final G3 verdict: the last G3 gate row in the file (or null).
  const g3 = gates.filter((g) => g.gate === 'G3').slice(-1)[0] || null;
  const run = rj(join(runDir, 'run.json'));
  const finalVerdict = run?.status || (g3 ? g3.verdict : null);
  const followUps = [];
  for (const g of gates) {
    if (Array.isArray(g.follow_ups)) for (const f of g.follow_ups) followUps.push(f);
  }
  return {
    verdict_counts: counts,
    final_verdict: finalVerdict,
    last_g3_verdict: g3 ? g3.verdict : null,
    last_g3_task_id: g3 ? g3.task_id : null,
    rework_count: reworkCount,
    rework_deltas: reworkDeltas,
    follow_ups: followUps,
    note: gates.length === 0 ? 'no gates.jsonl rows (run has no recorded verdicts)' : null,
  };
}

// ---------------------------------------------------------------------------
// AXIS 5 - ERROR RATE. Count gates.jsonl rows whose `error_class` field is
// set, grouped by value. Rows WITHOUT it produce NOTHING derived - the
// reader sees `error_class: not recorded (pre-scoring runs)` honestly.
// Known vocabulary (from the 20261008-1435-milestones score.md): worker-defect,
// worker-protocol, worker-crash, jev-false-positive, jev-false-negative,
// orchestrator, infra, spec-gap.
// ---------------------------------------------------------------------------
export function errorAxis(runDir) {
  const gates = jl(join(runDir, 'gates.jsonl')).filter(isGateRow);
  const byClass = {};
  let recorded = 0, without = 0;
  for (const g of gates) {
    const ec = g.error_class;
    if (typeof ec === 'string' && ec.length > 0) {
      byClass[ec] = (byClass[ec] || 0) + 1;
      recorded++;
    } else {
      without++;
    }
  }
  return {
    recorded_rows: recorded,
    rows_without_error_class: without,
    by_class: byClass,
    note: recorded === 0 ? 'error_class: not recorded (pre-scoring runs)' : null,
  };
}

// ---------------------------------------------------------------------------
// SCORE - assemble all 5 axes for one run dir. Always returns an object,
// never throws on a malformed row.
// ---------------------------------------------------------------------------
export function score(runDir, { rates } = {}) {
  return {
    cost: costAxis(runDir),
    time: timeAxis(runDir),
    price: priceAxis(runDir, rates),
    quality: qualityAxis(runDir),
    error_rate: errorAxis(runDir),
  };
}

// Pretty-printer for `fleet score <run-id>`. Mirrors the style of cost /
// timing: ALL CAPS section headers, two-space indent, blank line before
// percentages.
export function print(runId, s, options = {}) {
  const quiet = !!options.quiet;
  const fmtMs = (ms) => (ms / 60000).toFixed(1);
  const sumPhases = (kinds) => s.time.phases.filter((p) => kinds.includes(p.kind)).reduce((a, p) => a + p.ms, 0);
  const workerMs = sumPhases(['worker']);
  const orchMs = sumPhases(['orchestrator']);
  const otherMs = sumPhases(['other']);

  console.log(`SCORE  ${runId}`);
  // 1. COST
  console.log('1. COST  (tokens actually spent, per dispatch)');
  if (s.cost.worker_rows_total === 0) {
    console.log('  no tasks.jsonl rows');
  } else {
    console.log(`  workers total       ${s.cost.worker_tokens.toLocaleString('en-US')} tokens  (${s.cost.worker_rows_with_tokens}/${s.cost.worker_rows_total} rows recorded)`);
    for (const row of s.cost.per_task) {
      if (row.tokens != null) console.log(`    ${String(row.task_id).padEnd(30)} ${row.tokens.toLocaleString('en-US').padStart(12)}  ${row.model || '?'}`);
    }
    if (s.cost.note) console.log('  ' + s.cost.note);
  }
  console.log('  orchestrator tokens are NOT per-run meterable - they are part of the daily proxy spend');

  // 2. TIME
  console.log('2. TIME');
  if (s.time.missing_data) {
    console.log('  not enough timestamped events to analyse');
  } else {
    const total = s.time.totalMs || (workerMs + orchMs + otherMs) || 1;
    console.log(`  wall clock          ${fmtMs(s.time.totalMs)} min`);
    console.log(`  workers             ${fmtMs(workerMs)} min  (${Math.round(100 * workerMs / total)}%)`);
    console.log(`  orchestrator        ${fmtMs(orchMs)} min  (${Math.round(100 * orchMs / total)}%)`);
    console.log(`  other / gaps        ${fmtMs(otherMs)} min  (${Math.round(100 * otherMs / total)}%)`);
    const slowest = [...s.time.phases].sort((a, b) => b.ms - a.ms).slice(0, 3);
    if (slowest.length) {
      console.log('  slowest segments:');
      for (const p of slowest) console.log(`    ${fmtMs(p.ms).padStart(6)} min  ${p.kind.padEnd(13)} ${p.from} -> ${p.to}`);
    }
    if (s.time.instrumentation_gaps && s.time.instrumentation_gaps.length) {
      console.log(`  INSTRUMENTATION GAP: verdicts for ${s.time.instrumentation_gaps.join(', ')} have no dispatch row,`);
      console.log("  so that worker's duration cannot be measured. Record a task row per dispatch.");
    }
  }

  // 3. PRICE
  console.log('3. PRICE');
  if (!s.price.priced) {
    console.log('  price: UNPRICED (set model_rates in fleet/config.json)');
    if (s.price.unpriced_tokens > 0) console.log(`  unpriced tokens:    ${s.price.unpriced_tokens.toLocaleString('en-US')} (0-valued model_rates entries, not yet supplied)`);
    if (s.price.unknown_model_tokens > 0) console.log(`  unknown-model tokens: ${s.price.unknown_model_tokens.toLocaleString('en-US')} (no model row)`);
  } else {
    console.log(`  priced usd          $${s.price.priced_usd.toFixed(4)}  (${s.price.priced_tokens.toLocaleString('en-US')} priced tokens)`);
    for (const ln of s.price.lines) console.log(`    ${String(ln.task_id).padEnd(30)} ${ln.model.padEnd(20)} $${ln.usd.toFixed(4)}  (${ln.rate_key} @ $${ln.rate}/M)`);
    if (s.price.unpriced_tokens > 0) console.log(`  unpriced tokens:    ${s.price.unpriced_tokens.toLocaleString('en-US')}`);
  }

  // 4. QUALITY
  console.log('4. QUALITY');
  if (s.quality.verdict_counts && Object.keys(s.quality.verdict_counts).length) {
    const counts = s.quality.verdict_counts;
    const order = ['accept', 'verified', 'rework', 'rework-needed', 'escalate', 'abstain'];
    const printed = new Set();
    for (const v of order) if (counts[v]) { console.log(`  ${v.padEnd(20)} ${counts[v]}`); printed.add(v); }
    for (const v of Object.keys(counts).sort()) if (!printed.has(v)) console.log(`  ${v.padEnd(20)} ${counts[v]}`);
    console.log(`  final verdict       ${s.quality.final_verdict || '?'}`);
    if (s.quality.last_g3_verdict) console.log(`  last G3             ${s.quality.last_g3_verdict}  (${s.quality.last_g3_task_id || '?'})`);
    console.log(`  rework              ${s.quality.rework_count}  (deltas: ${s.quality.rework_deltas})`);
    if (s.quality.follow_ups && s.quality.follow_ups.length) {
      console.log(`  follow-ups          ${s.quality.follow_ups.length}`);
    }
    if (s.quality.note) console.log('  ' + s.quality.note);
  } else {
    console.log('  no gates.jsonl verdicts recorded');
  }

  // 5. ERROR RATE
  console.log('5. ERROR RATE');
  if (Object.keys(s.error_rate.by_class).length === 0) {
    console.log('  error_class: not recorded (pre-scoring runs)');
    console.log(`  rows without error_class: ${s.error_rate.rows_without_error_class}`);
  } else {
    for (const [k, v] of Object.entries(s.error_rate.by_class).sort((a, b) => b[1] - a[1]))
      console.log(`  ${k.padEnd(22)} ${v}`);
    console.log(`  (${s.error_rate.rows_without_error_class} rows without error_class - not a class)`);
  }
}
