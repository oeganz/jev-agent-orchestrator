// T5-jev-router CALIBRATION - a LIVE script (deliberately NOT part of the test
// suite: it calls the real JEV service and sweeps thresholds against labelled
// cases). Usage:
//   node fleet/bin/jev-route-calibrate.mjs           print the sweep + recommendation
//   node fleet/bin/jev-route-calibrate.mjs --write   also write jev.routing to fleet/config.json
//
// 12+ labelled tasks spanning the fleet roles (engineer, tester, devops,
// planner, orchestrator-only, none_fit). Each case: task text, the correct
// PRIMARY skill, and the true multi-select set. The router runs live over the
// REAL skill catalog (repo .claude/skills first, then ~/.claude/skills).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './lib/env.mjs';
loadEnv();
import { askJev } from './lib/jev.mjs';
import { skillCatalog, buildRouteQuestions, routeDecision, fingerprint, route } from './lib/jev-router.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));        // fleet/
const REPO = fileURLToPath(new URL('../..', import.meta.url));     // Agent/Orchestrator/
const CONFIG = join(ROOT, 'config.json');

// ---- labelled cases -----------------------------------------------------------
// primary: the single correct skill; needs: the true multi-select set (skills
// the task genuinely needs beyond the primary; the primary is always included
// implicitly by the sweep). none_fit cases use primary 'none_fit'.
const CASES = [
  { id: 'eng-flag', task: 'Add a --verbose flag to `fleet runs` with node:test coverage and one commit.', primary: 'fleet-engineer', needs: [] },
  { id: 'eng-bugfix', task: 'Fix the settle crash guard: tests first, then the fix in lib/orca.mjs.', primary: 'fleet-engineer', needs: ['fleet-tester'] },
  { id: 'test-verify', task: 'Verify the engineer commit e7b0bdb: rerun every suite, try to falsify the doctor CLI check, report did-NOT-verify sections.', primary: 'fleet-tester', needs: [] },
  { id: 'test-break', task: 'Break the acceptance criteria of task T3 on purpose: run the suites, mutate one expectation, confirm red.', primary: 'fleet-tester', needs: ['fleet-engineer'] },
  { id: 'devops-deploy', task: 'Deploy the <client> staging build and roll back if the health check fails.', primary: 'fleet-devops', needs: [] },
  { id: 'devops-rollback', task: 'Roll back yesterdays production release; the error rate doubled after the deploy.', primary: 'fleet-devops', needs: [] },
  { id: 'plan-dag', task: 'Turn the objective "migrate the run store to sqlite" into a task DAG of engineer-sized specs.', primary: 'fleet-planner', needs: ['fleet-engineer'] },
  { id: 'plan-specs', task: 'Decompose "add authentication to the dashboard" into self-contained task specs with observable acceptance.', primary: 'fleet-planner', needs: ['fleet-engineer', 'fleet-tester'] },
  { id: 'orch-gate', task: 'Run the G2 build gate on task T2: assemble signal-first state, paste raw output, apply gateVerdict, record the row.', primary: 'fleet-orchestrator', needs: ['jev-scoring'] },
  { id: 'orch-settle', task: 'Settle the run: release reclaimable Orca workers, archive user_takeover leaks, update run.json status.', primary: 'fleet-orchestrator', needs: [] },
  { id: 'orch-dispatch', task: 'Take the incoming objective, split it into engineer tasks, dispatch each as a subagent, run the gates.', primary: 'fleet-orchestrator', needs: ['fleet-planner', 'fleet-engineer', 'fleet-tester'] },
  { id: 'none-flight', task: 'Book a flight to Berlin next Tuesday and email me the confirmation.', primary: 'none_fit', needs: [] },
  { id: 'none-recipe', task: 'Write a birthday poem for my sister and post it to her Facebook wall.', primary: 'none_fit', needs: [] },
  { id: 'none-invoice', task: 'Reconcile the October invoices against the bank statements in Excel.', primary: 'none_fit', needs: [] },
];

// ---- live routing over the real catalog ---------------------------------------
const dirs = [join(REPO, '.claude', 'skills'), join(homedir(), '.claude', 'skills')];
const catalog = skillCatalog({ dirs });
const names = Object.keys(catalog);
console.log(`catalog: ${names.length} skills (repo first): ${names.join(', ')}`);
if (names.length > 255) { console.error('catalog exceeds the 255-option choice limit'); process.exit(1); }

const instructions = 'Which single skill should the worker load to do this task? Judge from the skill descriptions.';
const questions = buildRouteQuestions({ id: 'route', instructions, options: catalog, multi: true });
const fp = fingerprint(questions);
console.log(`questions fingerprint: ${fp}  (1 choice + ${names.length} per-skill nouls)`);

const results = [];
let degraded = 0;
// A live rate-limited run degrades and opens the breaker, and a degraded run
// cannot calibrate - so throttle (the free tier 429s on bursts) and give each
// case up to 4 attempts with growing back-off.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const throttledAsk = async (state, questions, opts) => {
  let last;
  for (let attempt = 1; attempt <= 12; attempt++) {
    last = await askJev(state, questions, { ...opts, breaker: { failures_to_open: 99, cooldown_ms: 1000 } });
    if (last.ok || last.fatal) return last;
    // The free tier's 429 window can outlast short back-offs; grow to ~2 min.
    await sleep(10000 * attempt);
  }
  return last;
};
for (const c of CASES) {
  const r = await route({ state: { task: c.task }, questions, ask: throttledAsk });
  await sleep(6000);
  if (!r.raw.ok) {
    degraded += 1;
    console.log(`  ${c.id}: DEGRADED ${r.raw.reason} ${r.raw.detail ?? ''}`);
    results.push({ ...c, degraded: true, choice: null, probs: {}, nouls: {} });
    continue;
  }
  const ch = r.raw.answers.route;
  results.push({
    ...c, degraded: false,
    choice: ch.choice,
    probs: ch.probabilities ?? {},
    nouls: Object.fromEntries(Object.entries(r.raw.answers)
      .filter(([k]) => k.startsWith('route_needs__'))
      .map(([k, v]) => [k.replace('route_needs__', ''), v.noul])),
  });
  const top = Object.entries(ch.probabilities ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([s, p]) => `${s}:${p.toFixed(2)}`).join(' ');
  console.log(`  ${c.id.padEnd(14)} expected=${c.primary.padEnd(18)} got=${String(ch.choice).padEnd(18)} top=[${top}] model=${r.raw.model}`);
}
if (degraded) { console.error(`${degraded} of ${CASES.length} cases degraded - calibration is not valid on a degraded run`); process.exit(1); }

// ---- choice accuracy + autoApply / abstain sweep --------------------------------
// The pick must survive routeDecision: chosen prob < abstain or < autoApply
// escalates, so "accuracy" at a given autoApply counts only DECIDED picks.
const correct = (r) => r.choice === sanitised(r.primary);
function sanitised(name) { return String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_'); }

const rawChoiceAcc = results.filter(correct).length / results.length;
console.log('');
console.log(`choice accuracy (raw argmax):        ${(rawChoiceAcc * 100).toFixed(1)}%  (${results.filter(correct).length}/${results.length})`);
const misroutes = results.filter(r => !correct(r));
if (misroutes.length) {
  console.log(`misrouted cases (${misroutes.length}):`);
  for (const r of misroutes) {
    console.log(`  ${r.id}: expected ${sanitised(r.primary)} got ${r.choice} at prob ${(r.probs?.[r.choice] ?? 0).toFixed(2)}`);
  }
}

console.log('');
console.log('autoApply sweep (choice accuracy among DECIDED picks; escalated = fallback to orchestrator):');
console.log('  auto_apply  decided  correct  acc(decided)  escalated  acc(all, escalate=miss)');
const ABSTAIN = 0.6;
let bestAA = null;
for (const aa of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
  let decided = 0, hit = 0;
  for (const r of results) {
    const d = routeDecision({ route: { type: 'choice', choice: r.choice, probabilities: r.probs } }, { autoApply: aa, abstain: ABSTAIN });
    if (d.decided_by === 'jev') { decided += 1; if (d.pick === sanitised(r.primary)) hit += 1; }
  }
  const accD = decided ? (hit / decided) : 0;
  const accAll = hit / results.length;
  console.log(`  ${aa.toFixed(2)}        ${String(decided).padStart(3)}      ${String(hit).padStart(3)}      ${(accD * 100).toFixed(1)}%         ${String(results.length - decided).padStart(3)}          ${(accAll * 100).toFixed(1)}%`);
  // auto_apply MUST sit strictly above abstain or the below-auto-apply tier is
  // unreachable and the two thresholds collapse into one; among ties prefer the
  // smaller (fewer escalations) - but never <= abstain.
  if (aa <= ABSTAIN) continue;
  if (!bestAA || accAll > bestAA.accAll || (accAll === bestAA.accAll && aa < bestAA.aa)) {
    bestAA = { aa, decided, hit, accD, accAll };
  }
}

// ---- multi threshold sweep ------------------------------------------------------
// For each case the TRUE set is {primary} union needs (sanitised). A hit is a
// needed skill with noul >= T; a false-add is an unneeded skill above T; a
// miss is a needed skill below T.
console.log('');
console.log('multi_threshold sweep (per-option nouls; true set = primary + needs):');
console.log('  thresh  hits  of  needed  false-adds  misses  cases_clean  cases_complete  precision  recall');
let bestT = null;
for (let t = 0.30; t <= 0.7001; t += 0.05) {
  const th = Math.round(t * 100) / 100;
  let hits = 0, needed = 0, falseAdds = 0, misses = 0, clean = 0, complete = 0;
  for (const r of results) {
    const truth = new Set([sanitised(r.primary), ...r.needs.map(sanitised)]);
    let caseComplete = true, caseClean = true;
    for (const [skill, noul] of Object.entries(r.nouls)) {
      if (truth.has(skill)) {
        needed += 1;
        if (noul >= th) hits += 1; else { misses += 1; caseComplete = false; }
      } else if (noul >= th) { falseAdds += 1; caseClean = false; }
    }
    if (caseClean) clean += 1;
    if (caseComplete) complete += 1;
  }
  const prec = hits + falseAdds ? hits / (hits + falseAdds) : 1;
  const rec_ = needed ? hits / needed : 0;
  console.log(`  ${th.toFixed(2)}   ${String(hits).padStart(4)}  of ${String(needed).padStart(4)}       ${String(falseAdds).padStart(4)}        ${String(misses).padStart(4)}       ${String(clean).padStart(3)}          ${String(complete).padStart(3)}          ${(prec * 100).toFixed(0)}%      ${(rec_ * 100).toFixed(0)}%`);
  if (!bestT || clean > bestT.clean || (clean === bestT.clean && misses < bestT.misses)) {
    bestT = { th, hits, needed, falseAdds, misses, clean, complete, prec, recall: rec_ };
  }
}

// ---- recommendation + optional write -------------------------------------------
const rec = {
  auto_apply: bestAA.aa,
  abstain: 0.6,
  multi_threshold: bestT.th,
  calibrated_on: new Date().toISOString().slice(0, 10),
  cases: CASES.length,
  model: 'see jev.model in this config - the id is returned per call; last run used ' + (results[0]?.model ?? 'unknown'),
};
console.log('');
console.log('recommendation (best combined: most clean multi cases, then fewest misses; auto_apply by acc(all)):');
console.log(JSON.stringify({ ...rec, model: undefined, auto_apply_reason: `decided ${bestAA.decided}/${CASES.length}, ${bestAA.hit} correct`, multi_threshold_reason: `${bestT.clean}/${CASES.length} cases clean, ${bestT.misses} misses, ${bestT.falseAdds} false-adds` }, null, 2));

if (process.argv.includes('--write')) {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  cfg.jev = cfg.jev ?? {};
  cfg.jev.routing = {
    auto_apply: rec.auto_apply,
    abstain: rec.abstain,
    multi_threshold: rec.multi_threshold,
    calibrated_on: rec.calibrated_on,
    cases: rec.cases,
    model: 'jev-1-13-free (id returned per call; see jev.model)',
  };
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`wrote jev.routing to ${CONFIG}`);
} else {
  console.log('dry run - pass --write to persist jev.routing to fleet/config.json');
}
