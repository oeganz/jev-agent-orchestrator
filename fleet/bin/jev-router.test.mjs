// T5-jev-router: hermetic tests for the dynamic JEV router. No network, no
// filesystem outside injected fakes. askJev/askJevChain are always injected.
// T7-router-wiring: config adapters (routingConfig/askFromConfig/loadFleetConfig)
// plus DOC-AS-TEST cases that execute the SKILL.md 5c recipes verbatim through
// the real askJevChain with a stubbed systemone fetch.
// T9-recipe-coldproof: routeDecision infers the id from a single choice answer
// (T8 F1: a custom-id recipe silently escalated malformed-missing), route()
// returns that id, and the 5c snippets are EXTRACTED from the doc and EXECUTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as realReadFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, dirname as pathDirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as routerExports from './lib/jev-router.mjs';
import * as jevExports from './lib/jev.mjs';
import * as envExports from './lib/env.mjs';
import {
  fingerprint, skillCatalog, buildRouteQuestions, routeDecision,
  buildGateQuestions, route,
  routingConfig, askFromConfig, loadFleetConfig, deletedLines,
  parseDiff, unmatchedDeletions, deletionCheck,
} from './lib/jev-router.mjs';

// Tripwire: nothing here may touch the real network.
let realFetchCalls = 0;
globalThis.fetch = async () => { realFetchCalls += 1; throw new Error('network access forbidden in jev-router.test.mjs'); };

// --------------------------------------------------------------- injected fs ----
function fakeFs(tree) {
  const BS = String.fromCharCode(92);   // backslash without a literal escape
  const norm = (p) => String(p).split(BS).join('/').replace(/\/+$/, '');
  const readFileSync = (p) => {
    const hit = Object.entries(tree).find(([k]) => norm(k) === norm(p));
    if (!hit) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    return hit[1];
  };
  const readdirSync = (p) => {
    const base = norm(p);
    const set = new Set();
    for (const k of Object.keys(tree)) {
      const kn = norm(k);
      if (kn === base) continue;
      if (kn.startsWith(base + '/')) set.add(kn.slice(base.length + 1).split('/')[0]);
    }
    if (!set.size) { const e = new Error('ENOTDIR: ' + p); e.code = 'ENOENT'; throw e; }
    return [...set];
  };
  return { readFileSync, readdirSync };
}

const FRONTMATTER = (name, desc) => '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n\n# ' + name + '\n';

// -------------------------------------------------------------- fingerprint ----

test('fingerprint: stable across key order, sensitive to wording', () => {
  const a = { choice: { type: 'choice', instructions: 'Which skill?', criteria: { x: 'a', y: 'b' } }, n1: { type: 'noul', instructions: 'needs x?' } };
  const b = { n1: { type: 'noul', instructions: 'needs x?' }, choice: { criteria: { y: 'b', x: 'a' }, instructions: 'Which skill?', type: 'choice' } };
  assert.equal(fingerprint(a), fingerprint(b), 'same content in any key order hashes the same');
  const c = JSON.parse(JSON.stringify(a));
  c.choice.instructions = 'Which skill now?';
  assert.notEqual(fingerprint(a), fingerprint(c), 'a wording change changes the fingerprint');
});

test('fingerprint: 12 lowercase hex chars', () => {
  const fp = fingerprint({ q: { type: 'noul', instructions: 'x' } });
  assert.match(fp, /^[0-9a-f]{12}$/);
});

test('fingerprint: empty object is still a stable 12-hex value', () => {
  assert.match(fingerprint({}), /^[0-9a-f]{12}$/);
  assert.equal(fingerprint({}), fingerprint({}));
});

// ------------------------------------------------------------- skillCatalog ----

test('skillCatalog: reads frontmatter name/description from each dir', () => {
  const fs = fakeFs({
    '/repo/.claude/skills/engineer/SKILL.md': FRONTMATTER('engineer', 'implement a task spec'),
    '/repo/.claude/skills/tester/SKILL.md': FRONTMATTER('tester', 'verify a finished task'),
  });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills'], fs });
  assert.deepEqual(cat, { engineer: 'implement a task spec', tester: 'verify a finished task' });
});

test('skillCatalog: dedupe precedence - earlier (repo) dir wins on duplicate names', () => {
  const fs = fakeFs({
    '/repo/.claude/skills/dup/SKILL.md': FRONTMATTER('dup', 'repo wins'),
    '/home/.claude/skills/dup/SKILL.md': FRONTMATTER('dup', 'home loses'),
  });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills', '/home/.claude/skills'], fs });
  assert.equal(cat.dup, 'repo wins');
});

test('skillCatalog: a dir entry without SKILL.md is skipped, not an error', () => {
  const fs = fakeFs({
    '/repo/.claude/skills/real/SKILL.md': FRONTMATTER('real', 'has one'),
    '/repo/.claude/skills/orphan/README.md': 'no SKILL.md here',
  });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills'], fs });
  assert.deepEqual(Object.keys(cat), ['real']);
});

test('skillCatalog: SKILL.md without a description line is skipped', () => {
  const fs = fakeFs({
    '/repo/.claude/skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n# no description\n',
    '/repo/.claude/skills/desc/SKILL.md': FRONTMATTER('desc', 'kept'),
  });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills'], fs });
  assert.deepEqual(Object.keys(cat), ['desc']);
});

test('skillCatalog: a missing dir contributes nothing instead of throwing', () => {
  const fs = fakeFs({ '/repo/.claude/skills/real/SKILL.md': FRONTMATTER('real', 'has one') });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills', '/nope'], fs });
  assert.deepEqual(cat, { real: 'has one' });
});

test('skillCatalog: folded (>-style) YAML descriptions are skipped, not mis-parsed', () => {
  // orchestration-style multi-line folded description: the single-line regex
  // must not lift a continuation line and present it as a description.
  const fs = fakeFs({
    '/home/.claude/skills/folded/SKILL.md': '---\nname: folded\ndescription: >-\n  multi line\n  folded text\n---\n',
    '/repo/.claude/skills/flat/SKILL.md': FRONTMATTER('flat', 'flat desc'),
  });
  const cat = skillCatalog({ dirs: ['/repo/.claude/skills', '/home/.claude/skills'], fs });
  assert.deepEqual(cat, { flat: 'flat desc' });
});

// -------------------------------------------------------- buildRouteQuestions ----

const CAT = { 'fleet-engineer': 'implement a task spec', 'fleet-tester': 'verify a finished task' };

test('buildRouteQuestions: single mode emits only the choice, always with none_fit', () => {
  const q = buildRouteQuestions({ id: 'route', instructions: 'Which skill?', options: CAT });
  assert.deepEqual(Object.keys(q), ['route']);
  assert.equal(q.route.type, 'choice');
  assert.equal(q.route.criteria.none_fit, 'None of these fit');
  assert.ok(q.route.criteria.fleet_engineer, 'criteria keys are sanitised');
  assert.ok(q.route.criteria.fleet_tester);
  assert.equal(q.route.criteria.fleet_engineer, 'implement a task spec', 'description kept verbatim');
});

test('buildRouteQuestions: multi mode adds one noul per option keyed by sanitised name', () => {
  const q = buildRouteQuestions({ id: 'route', instructions: 'Which skill?', options: CAT, multi: true });
  assert.equal(Object.keys(q).length, 3);
  assert.equal(q.route_needs__fleet_engineer.type, 'noul');
  assert.match(q.route_needs__fleet_engineer.instructions, /fleet-engineer/);
  assert.match(q.route_needs__fleet_engineer.instructions, /implement a task spec/);
  assert.equal(q.route_needs__fleet_tester.type, 'noul');
});

test('buildRouteQuestions: option keys are sanitised to [a-z0-9_]', () => {
  const q = buildRouteQuestions({ id: 'r', instructions: 'Which?', options: { 'Fleet-Engineer (code)': 'x', 'UPPER': 'y' }, multi: true });
  assert.deepEqual(Object.keys(q.r.criteria), ['fleet_engineer__code_', 'upper', 'none_fit']);
  assert.ok(q.r_needs__fleet_engineer__code_ && q.r_needs__upper, 'noul keys use the same sanitised names');
});

test('buildRouteQuestions: none_fit appears exactly once even with odd option names', () => {
  const q = buildRouteQuestions({ id: 'r', instructions: 'Which?', options: { a: 'x', b: 'y' } });
  assert.equal(Object.values(q.r.criteria).filter(v => v === 'None of these fit').length, 1);
  assert.equal(q.r.criteria.none_fit, 'None of these fit');
});

test('buildRouteQuestions: more than 255 choice options throws a clear error naming the limit', () => {
  const big = {};
  for (let i = 0; i < 256; i++) big['o' + i] = 'd';
  assert.throws(() => buildRouteQuestions({ id: 'r', instructions: 'Which?', options: big }), /255/);
});

test('buildRouteQuestions: exactly 255 options plus none_fit is allowed', () => {
  const big = {};
  for (let i = 0; i < 255; i++) big['o' + i] = 'd';
  const q = buildRouteQuestions({ id: 'r', instructions: 'Which?', options: big });
  // 255 options + none_fit = 256 criteria keys - the limit counts the caller's
  // options; none_fit is the mandatory escape hatch on top.
  assert.equal(Object.keys(q.r.criteria).length, 256);
});

test('buildRouteQuestions: criteria is an OBJECT (JEV choice shape), not an array', () => {
  const q = buildRouteQuestions({ id: 'r', instructions: 'Which?', options: CAT });
  assert.equal(typeof q.r.criteria, 'object');
  assert.ok(!Array.isArray(q.r.criteria));
});

// ------------------------------------------------------------ routeDecision ----

const CH = (choice, probabilities) => ({ type: 'choice', choice, probabilities, confidence: probabilities[choice] ?? 0 });

test('routeDecision: confident pick is decided by jev with the chosen prob', () => {
  const d = routeDecision(
    { best: CH('fleet-engineer', { 'fleet-engineer': 0.92, 'fleet-tester': 0.05, none_fit: 0.03 }) },
    { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 },
  );
  assert.equal(d.pick, 'fleet-engineer');
  assert.equal(d.prob, 0.92);
  assert.equal(d.decided_by, 'jev');
  assert.equal(d.branch, 'confident');
  assert.deepEqual(d.multi, []);
});

test('routeDecision: uses the CHOSEN option probability, not the max (T4 lesson)', () => {
  const d = routeDecision(
    { best: CH('fleet-engineer', { 'fleet-engineer': 0.05, 'fleet-tester': 0.02, none_fit: 0.93 }) },
    { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 },
  );
  assert.equal(d.decided_by, 'escalate');
  assert.equal(d.prob, 0.05);
  assert.equal(d.branch, 'abstain');
});

test('routeDecision: escalates on missing choice answer', () => {
  const d = routeDecision({}, { id: 'best', autoApply: 0.8, abstain: 0.6 });
  assert.equal(d.pick, null);
  assert.equal(d.decided_by, 'escalate');
  assert.equal(d.branch, 'malformed-missing');
});

test('routeDecision: escalates on a non-string choice', () => {
  const d = routeDecision({ best: { type: 'choice', choice: null, probabilities: { a: 1 } } }, { id: 'best' });
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'malformed-choice']);
});

test('routeDecision: escalates when the choice names an option absent from probabilities', () => {
  const d = routeDecision({ best: CH('ghost', { a: 0.5, none_fit: 0.5 }) }, { id: 'best' });
  assert.equal(d.branch, 'malformed-probability');
});

test('routeDecision: escalates on a non-finite or non-numeric chosen probability', () => {
  assert.equal(routeDecision({ best: CH('a', { a: NaN, b: 1 }) }, { id: 'best' }).branch, 'malformed-probability');
  assert.equal(routeDecision({ best: CH('a', { a: 'yes', b: 1 }) }, { id: 'best' }).branch, 'malformed-probability');
});

test('routeDecision: none_fit escalates - it is a no-match answer, not a pick', () => {
  const d = routeDecision({ best: CH('none_fit', { none_fit: 0.95, a: 0.05 }) }, { id: 'best', autoApply: 0.8, abstain: 0.6 });
  assert.equal(d.pick, null);
  assert.equal(d.decided_by, 'escalate');
  assert.equal(d.branch, 'none-fit');
});

test('routeDecision: chosen prob below abstain escalates as abstain', () => {
  const d = routeDecision({ best: CH('a', { a: 0.55, none_fit: 0.45 }) }, { id: 'best', autoApply: 0.8, abstain: 0.6 });
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'abstain']);
});

test('routeDecision: chosen prob at/above abstain but below autoApply escalates as below-auto-apply', () => {
  const d = routeDecision({ best: CH('a', { a: 0.75, none_fit: 0.25 }) }, { id: 'best', autoApply: 0.8, abstain: 0.6 });
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'below-auto-apply']);
});

test('routeDecision: multi collects option names whose noul >= multiThreshold (inclusive)', () => {
  const answers = {
    best: CH('fleet_engineer', { fleet_engineer: 0.9, fleet_tester: 0.06, none_fit: 0.04 }),
    best_needs__fleet_engineer: { type: 'noul', noul: 0.72 },
    best_needs__fleet_tester: { type: 'noul', noul: 0.5 },
  };
  const d = routeDecision(answers, { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 });
  assert.equal(d.decided_by, 'jev');
  assert.deepEqual(d.multi, ['fleet_engineer', 'fleet_tester'], '>= threshold is inclusive');
});

test('routeDecision: multi maps sanitised keys back to ORIGINAL option names when options is passed', () => {
  const answers = {
    best: CH('fleet_engineer', { fleet_engineer: 0.9, fleet_tester: 0.06, none_fit: 0.04 }),
    best_needs__fleet_engineer: { type: 'noul', noul: 0.72 },
    best_needs__fleet_tester: { type: 'noul', noul: 0.4 },
  };
  const d = routeDecision(answers, { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5, options: CAT });
  assert.deepEqual(d.multi, ['fleet-engineer']);
});

test('routeDecision: multi is still computed on an escalated pick', () => {
  const answers = {
    best: CH('none_fit', { none_fit: 0.9, fleet_engineer: 0.1 }),
    best_needs__fleet_engineer: { type: 'noul', noul: 0.9 },
  };
  const d = routeDecision(answers, { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 });
  assert.equal(d.pick, null);
  assert.deepEqual(d.multi, ['fleet_engineer']);
});

test('routeDecision: absent multiThreshold -> multi null with note, never a guessed cut', () => {
  const answers = {
    best: CH('fleet_engineer', { fleet_engineer: 0.9, none_fit: 0.1 }),
    best_needs__fleet_engineer: { type: 'noul', noul: 0.9 },
  };
  const d = routeDecision(answers, { id: 'best', autoApply: 0.8, abstain: 0.6 });
  assert.equal(d.multi, null);
  assert.equal(d.multiNote, 'multi-uncalibrated');
});

test('routeDecision: a multiThreshold with no noul answers yields an empty multi', () => {
  const d = routeDecision({ best: CH('a', { a: 0.9, none_fit: 0.1 }) }, { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 });
  assert.deepEqual(d.multi, []);
});

test('routeDecision: a non-finite multi noul is ignored, not fatal', () => {
  const answers = {
    best: CH('a', { a: 0.9, none_fit: 0.1 }),
    best_needs__a: { type: 'noul', noul: 'high' },
  };
  const d = routeDecision(answers, { id: 'best', autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 });
  assert.deepEqual(d.multi, []);
});

// ------------------------------- T9: single-choice id inference (T8 finding F1) ----
//
// T8 F1: `buildRouteQuestions({id:'skill', ...})` keys the answer under 'skill'
// while 5c's `routeDecision(r.raw.answers, {...routingConfig(cfg), options})`
// leaves id at its 'route' default -> malformed-missing on a clean 0.86 answer.
// An absent id now uses the ONE choice answer when there is exactly one; with
// zero or several choice answers it escalates malformed-ambiguous-id rather
// than guess. An explicit id keeps today's strict behaviour.

test('routeDecision: no id + exactly ONE choice answer -> that answer decides (T8 F1)', () => {
  const d = routeDecision(
    { skill: CH('fleet-engineer', { 'fleet-engineer': 0.86, 'fleet-tester': 0.1, none_fit: 0.04 }) },
    { autoApply: 0.8, abstain: 0.6 },
  );
  assert.equal(d.decided_by, 'jev', 'a custom-id recipe run verbatim now decides');
  assert.equal(d.pick, 'fleet-engineer');
  assert.equal(d.branch, 'confident');
});

test('routeDecision: no id + exactly ONE choice answer -> multi nouls keyed by that id are collected', () => {
  const answers = {
    skill: CH('fleet_engineer', { fleet_engineer: 0.9, fleet_tester: 0.06, none_fit: 0.04 }),
    skill_needs__fleet_engineer: { type: 'noul', noul: 0.72 },
    skill_needs__fleet_tester: { type: 'noul', noul: 0.2 },
  };
  const d = routeDecision(answers, { autoApply: 0.8, abstain: 0.6, multiThreshold: 0.5 });
  assert.equal(d.decided_by, 'jev');
  assert.deepEqual(d.multi, ['fleet_engineer'], 'multiOut follows the inferred id, not the default');
});

test('routeDecision: no id + TWO choice answers -> escalate malformed-ambiguous-id, never guess', () => {
  const answers = {
    skill: CH('fleet-engineer', { 'fleet-engineer': 0.9, none_fit: 0.1 }),
    other: CH('fleet-tester', { 'fleet-tester': 0.9, none_fit: 0.1 }),
  };
  const d = routeDecision(answers, { autoApply: 0.8, abstain: 0.6 });
  assert.equal(d.pick, null);
  assert.equal(d.decided_by, 'escalate');
  assert.equal(d.branch, 'malformed-ambiguous-id');
});

test('routeDecision: no id + ZERO choice answers -> escalate malformed-ambiguous-id', () => {
  const d = routeDecision(
    { only_noul: { type: 'noul', noul: 0.5 } },
    { autoApply: 0.8, abstain: 0.6 },
  );
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'malformed-ambiguous-id']);
});

test('routeDecision: no id + empty answers -> escalate malformed-ambiguous-id (not silent malformed-missing)', () => {
  const d = routeDecision({}, { autoApply: 0.8, abstain: 0.6 });
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'malformed-ambiguous-id']);
});

test('routeDecision: an explicit WRONG id stays today\'s strict malformed-missing', () => {
  const answers = { skill: CH('fleet-engineer', { 'fleet-engineer': 0.9, none_fit: 0.1 }) };
  const d = routeDecision(answers, { id: 'route', autoApply: 0.8, abstain: 0.6 });
  assert.deepEqual([d.pick, d.decided_by, d.branch], [null, 'escalate', 'malformed-missing']);
});

test('routeDecision: an explicit CORRECT custom id decides as before', () => {
  const answers = { skill: CH('fleet-engineer', { 'fleet-engineer': 0.9, none_fit: 0.1 }) };
  const d = routeDecision(answers, { id: 'skill', autoApply: 0.8, abstain: 0.6 });
  assert.equal(d.decided_by, 'jev');
  assert.equal(d.pick, 'fleet-engineer');
});

// -------------------------------------------------------- buildGateQuestions ----

test('buildGateQuestions: one not_met noul per criterion, one violated noul per constraint, core nouls, route choice', () => {
  const g = buildGateQuestions({
    criteria: ['suite exits 0', 'raw output pasted'],
    constraints: ['no new deps'],
  });
  assert.equal(g.questions.not_met_0.type, 'noul');
  assert.match(g.questions.not_met_0.instructions, /suite exits 0/);
  assert.equal(g.questions.not_met_1.type, 'noul');
  assert.match(g.questions.not_met_1.instructions, /raw output pasted/);
  assert.equal(g.questions.violated_0.type, 'noul');
  assert.match(g.questions.violated_0.instructions, /no new deps/);
  for (const core of ['scope_creep', 'evidence_gap', 'tests_missing']) {
    assert.equal(g.questions[core].type, 'noul', core);
  }
  assert.match(g.questions.evidence_gap.instructions, /evidence/);
  assert.equal(g.questions.route.type, 'choice');
  assert.deepEqual(Object.keys(g.questions.route.criteria), ['accept', 'rework', 'replan', 'ask_user', 'none_fit']);
});

test('buildGateQuestions: criteriaIndex maps only the keys actually emitted', () => {
  const g = buildGateQuestions({ criteria: ['suite exits 0', 'raw output pasted'] });
  assert.deepEqual(g.criteriaIndex, { not_met_0: 'suite exits 0', not_met_1: 'raw output pasted' });
});

test('buildGateQuestions: criteriaIndex covers constraints too', () => {
  const g = buildGateQuestions({ criteria: ['c1'], constraints: ['k1', 'k2'] });
  assert.deepEqual(g.criteriaIndex, { not_met_0: 'c1', violated_0: 'k1', violated_1: 'k2' });
});

test('buildGateQuestions: returns a stable fingerprint of the question set', () => {
  const g = buildGateQuestions({ criteria: ['c1'] });
  assert.match(g.fingerprint, /^[0-9a-f]{12}$/);
  const g2 = buildGateQuestions({ criteria: ['c1'] });
  assert.equal(g.fingerprint, g2.fingerprint, 'identical criteria fingerprint identically');
  const g3 = buildGateQuestions({ criteria: ['different'] });
  assert.notEqual(g.fingerprint, g3.fingerprint);
});

test('buildGateQuestions: custom routes replace the defaults and always gain none_fit', () => {
  const g = buildGateQuestions({ criteria: ['c1'], routes: { ship: 'all green', hold: 'not green' } });
  assert.deepEqual(Object.keys(g.questions.route.criteria), ['ship', 'hold', 'none_fit']);
});

test('buildGateQuestions: default route descriptions say WHEN to pick each', () => {
  const g = buildGateQuestions({ criteria: ['c1'] });
  for (const k of ['accept', 'rework', 'replan', 'ask_user']) assert.ok(g.questions.route.criteria[k].length > 10, k);
});

test('buildGateQuestions: criterion wording lands in the question, so a flag names the failing criterion', () => {
  const g = buildGateQuestions({ criteria: ['the four reproduced defects each escalate'] });
  assert.match(g.questions.not_met_0.instructions, /the four reproduced defects each escalate/);
});

// ------------------------------------ T2-evidence-nouls: scoped evidence noul ----
//
// Measured 2026-10-07 (fleet/runs/20261007-1009-fleet-followups/gates.jsonl):
// the GENERIC evidence_gap noul fired on clean work - 0.63/0.73/0.69 (T7), 0.75
// (T9), 0.47 (this run, T1) - while every per-criterion noul was <= 0.20 and the
// orchestrator reproduced every criterion. It tracked the NUMBER of side claims
// in a long report (TDD narrative, design notes) that no evidence could show.
// The noul is now scoped to ACCEPTANCE CRITERIA; the key stays `evidence_gap`
// so gates.jsonl stays comparable.
const OLD_EVIDENCE_GAP = 'Does the report claim results that the raw evidence pasted in state does not show?';

test('buildGateQuestions: evidence_gap is scoped to acceptance criteria, not any side claim', () => {
  const g = buildGateQuestions({ criteria: ['suite exits 0'] });
  const w = g.questions.evidence_gap.instructions;
  assert.equal(g.questions.evidence_gap.type, 'noul', 'the key stays evidence_gap');
  assert.match(w, /ACCEPTANCE CRITERION/, 'scoped to acceptance criteria');
  assert.match(w, /raw evidence/, 'still about raw evidence in state');
  assert.notEqual(w, OLD_EVIDENCE_GAP, 'the generic wording is replaced');
  assert.match(w, /design notes|process narrative/, 'names the side claims it must ignore');
});

test('buildGateQuestions: the evidence_gap wording change bumps the fingerprint', () => {
  const built = buildGateQuestions({ criteria: ['a', 'b'], constraints: ['c'] });
  const oldSet = JSON.parse(JSON.stringify(built.questions));
  oldSet.evidence_gap.instructions = OLD_EVIDENCE_GAP;
  assert.notEqual(built.fingerprint, fingerprint(oldSet),
    'a wording change to the evidence noul must move the fingerprint');
  // regression pin: the exact pre-T2 set fingered 1aced7a5f7fa; it must not now.
  assert.notEqual(built.fingerprint, '1aced7a5f7fa', 'the fingerprint is not the old one');
});

test('buildGateQuestions: no deleted_out_of_scope noul without a diff input', () => {
  const g = buildGateQuestions({ criteria: ['c1'] });
  assert.equal(g.questions.deleted_out_of_scope, undefined, 'absent when no diff is given');
  assert.equal(g.criteriaIndex.deleted_out_of_scope, undefined);
});

test('buildGateQuestions: deletedOutsideScope lines add the deleted_out_of_scope noul (backward compat)', () => {
  const g = buildGateQuestions({
    criteria: ['c1'],
    diff: { deletedOutsideScope: ['  - a policy rule with no replacement'] },
  });
  const q = g.questions.deleted_out_of_scope;
  assert.equal(q.type, 'noul');
  assert.match(q.instructions, /DELETED lines that have no replacement in the diff/);
  assert.match(q.instructions, /remove a rule, instruction or behaviour that the task did not ask to remove/);
  assert.match(g.stateAppendix, /--- DELETED LINES WITH NO REPLACEMENT \(file: line\) ---/);
  assert.match(g.stateAppendix, /- a policy rule with no replacement/);
});

test('buildGateQuestions: an EMPTY deletedOutsideScope (or numstat-only diff) adds no noul', () => {
  const empty = buildGateQuestions({ criteria: ['c1'], diff: { deletedOutsideScope: [] } });
  assert.equal(empty.questions.deleted_out_of_scope, undefined);
  assert.equal(empty.stateAppendix, '');
  const numstatOnly = buildGateQuestions({ criteria: ['c1'], diff: { numstat: '3\t1\tfleet/bin/x.mjs' } });
  assert.equal(numstatOnly.questions.deleted_out_of_scope, undefined, 'an in-place rewrite (adds and deletes) needs no noul');
  assert.equal(numstatOnly.stateAppendix, '');
});

test('deletedLines: extracts deleted lines, skipping --- headers and +++ additions', () => {
  const diff = [
    'diff --git a/fleet/x.mjs b/fleet/x.mjs',
    '--- a/fleet/x.mjs',
    '+++ b/fleet/x.mjs',
    '@@ -1,3 +1,2 @@',
    '-removed rule A',
    ' context line',
    '+added line B',
    '-removed rule C',
  ].join('\n');
  assert.deepEqual(deletedLines(diff), ['removed rule A', 'removed rule C']);
});

test('deletedLines: handles CRLF line endings', () => {
  const diff = 'diff --git a/f.mjs b/f.mjs\r\n--- a/f.mjs\r\n+++ b/f.mjs\r\n@@ -1 +1 @@\r\n-old rule\r\n+new rule\r\n';
  assert.deepEqual(deletedLines(diff), ['old rule']);
});

test('deletedLines: empty or headless input -> []', () => {
  assert.deepEqual(deletedLines(''), []);
  assert.deepEqual(deletedLines('@@ -1 +0,0 @@\n'), []);
  assert.deepEqual(deletedLines('--- a/f\n+++ b/f\n'), [], 'a header-only diff deletes nothing');
});

// ------------------- T2r-unmatched-deletions: parseDiff / unmatchedDeletions ----
//
// T3-verify findings F1-F3: the 5c recipe never put the deleted lines into the
// JEV state (a real out-of-scope rule deletion scored 0.16), the documented
// grep "^-[^-]" dropped deleted markdown bullets (a deleted "- rule" is the diff
// line "-- rule"; on the real T9 diff the grep lost 17 of 71 deletions including
// the section-6 ALWAYS rules), and passing ALL deletions put in-place rewrites in
// the uncertain band (0.46). parseDiff() reads the real structure (---/+++ are
// headers ONLY before the first @@ of a file), unmatchedDeletions() drops every
// deletion with a similar-enough addition in the same file, and
// buildGateQuestions() returns a stateAppendix the caller appends to evidence.

// The REAL T9 incident diff (git diff -U0 6030fe4..2bffe7e -- SKILL.md): the
// commit that deleted section 6's body. It deleted 71 lines; grep "^-[^-]"
// keeps only 54 and loses the ALWAYS rules.
const T9_FIXTURE = realReadFileSync(
  fileURLToPath(new URL('./fixtures/t9-skill-doc-section6.diff', import.meta.url)), 'utf8');

test('parseDiff: multi-file CRLF diff - ---/+++ are headers only BEFORE the first @@ of a file', () => {
  const diff = [
    'commit 0123456789abcdef',                    // preamble before the first file: ignored
    'diff --git a/sql/a.lua b/sql/a.lua',
    'index 1111111..2222222 100644',
    '--- a/sql/a.lua',
    '+++ b/sql/a.lua',
    '@@ -1,4 +1,4 @@',
    '--- SQL comment',                            // deleted line whose CONTENT starts with '--'
    ' --- looks like a header',                   // CONTEXT line: space prefix wins
    '+-- SQL comment reworded',
    '---- yaml hr',                               // deleted line whose content starts with '---'
    'diff --git a/doc/b.md b/doc/b.md',
    'old mode 100644',
    'new mode 100755',
    '--- a/doc/b.md',
    '+++ b/doc/b.md',
    '@@ -12,2 +12,1 @@',
    '-- markdown bullet',                         // deleted bullet: content '- markdown bullet'
    '+- markdown bullet moved',
    '\\ No newline at end of file',
  ].join('\r\n');
  assert.deepEqual(parseDiff(diff), [
    { file: 'sql/a.lua', deleted: ['-- SQL comment', '--- yaml hr'], added: ['-- SQL comment reworded'], binary: false },
    { file: 'doc/b.md', deleted: ['- markdown bullet'], added: ['- markdown bullet moved'], binary: false },
  ]);
});

test('parseDiff: a bare "\\ No newline" marker is ignored; a deletion STARTING with backslash is kept; binary notices set binary', () => {
  const diff = [
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-alpha rule',
    '-\\ No newline trick: content that starts with a backslash',
    '\\ No newline at end of file',
  ].join('\n');
  const files = parseDiff(diff);
  assert.equal(files[0].binary, true, 'a "Binary files ... differ" notice is recorded');
  assert.deepEqual(files[0].deleted, []);
  assert.deepEqual(files[0].added, []);
  assert.equal(files[1].file, 'gone.txt');
  assert.deepEqual(files[1].deleted, [
    'alpha rule',
    '\\ No newline trick: content that starts with a backslash',
  ], 'only a BARE backslash line is the no-newline marker');
});

test('deletedLines: keeps a deleted "-- SQL comment" and markdown "- rule" bullet (the old stateless parse mistook them for headers)', () => {
  const diff = [
    'diff --git a/policy.md b/policy.md',
    '--- a/policy.md',
    '+++ b/policy.md',
    '@@ -3,3 +3,1 @@',
    '-- rule',             // content: '- rule'
    '--- SQL comment',     // content: '-- SQL comment'
    '+kept',
  ].join('\n');
  assert.deepEqual(deletedLines(diff), ['- rule', '-- SQL comment']);
});

test('unmatchedDeletions: the REAL T9 diff keeps the deleted section-6 ALWAYS rules the grep dropped', () => {
  const out = unmatchedDeletions(T9_FIXTURE);
  const lines = out.map(u => u.line);
  // The fixture has 72 '-' lines: 1 '--- a/' header, 8 blank deletions, 63
  // content deletions. parseDiff keeps all 71 deletions (blanks included);
  // deletedLines() returns the 63 non-blank ones; grep "^-[^-]" would keep only
  // 54 - it drops the 9 content lines whose CONTENT starts with '-' (markdown
  // bullets), which is exactly the section-6 ALWAYS rules this noul exists for.
  assert.equal(deletedLines(T9_FIXTURE).length, 63);
  assert.ok(lines.includes('- run the acceptance commands yourself and capture raw output'),
    'the ALWAYS rule the doc-literal grep pipeline dropped survives');
  assert.ok(lines.some(l => l.includes('A disagreement is')), 'the disagreement-rule lead-in survives');
  assert.ok(deletedLines(T9_FIXTURE).includes('- check each acceptance criterion one by one'));
  assert.ok(out.every(u => u.file === '.claude/skills/fleet-orchestrator/SKILL.md'), 'file attribution is kept');
});

test('unmatchedDeletions: a pure in-place rewrite diff yields [] (those deletions have replacements)', () => {
  const diff = [
    'diff --git a/fleet/bin/lib/jev-router.mjs b/fleet/bin/lib/jev-router.mjs',
    '--- a/fleet/bin/lib/jev-router.mjs',
    '+++ b/fleet/bin/lib/jev-router.mjs',
    '@@ -127 +127 @@',
    '-One writer at a time (6.2: only the engineer role may write code).',
    '+One writer at a time (design spec 6.2: only the engineer role may write code).',
    '@@ -210 +210 @@',
    '-import { loadFleetConfig, buildGateQuestions, askFromConfig } from \'./lib/jev-router.mjs\';',
    '+import { loadFleetConfig, buildGateQuestions, deletedLines, askFromConfig } from \'./lib/jev-router.mjs\';',
  ].join('\n');
  assert.deepEqual(unmatchedDeletions(diff), []);
});

test('unmatchedDeletions: similarity is the inclusive token-Jaccard cut; blank deletions never count', () => {
  const diff = [
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,3 +1,2 @@',
    '-',                            // a deleted blank line is noise, not a signal
    '-alpha beta gamma',
    '-totally unrelated words here',
    '+alpha beta gamma delta',      // Jaccard 3/4 = 0.75 vs 'alpha beta gamma'
  ].join('\n');
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 'f', line: 'totally unrelated words here' }]);
  assert.deepEqual(unmatchedDeletions(diff, { similarity: 0.99 }), [
    { file: 'f', line: 'alpha beta gamma' },
    { file: 'f', line: 'totally unrelated words here' },
  ]);
});

test('unmatchedDeletions: additions in a DIFFERENT file cannot match a deletion', () => {
  const diff = [
    'diff --git a/owned.mjs b/owned.mjs',
    '--- a/owned.mjs',
    '+++ b/owned.mjs',
    '@@ -1 +1 @@',
    '-run the acceptance commands yourself and capture raw output',
    '+run the acceptance commands yourself and capture the raw output',
    'diff --git a/policy.md b/policy.md',
    '--- a/policy.md',
    '+++ b/policy.md',
    '@@ -9 +9,2 @@',
    '-run the acceptance commands yourself and capture raw output',
    '+unrelated addition',
  ].join('\n');
  assert.deepEqual(unmatchedDeletions(diff), [
    { file: 'policy.md', line: 'run the acceptance commands yourself and capture raw output' },
  ], 'the owned-file rewrite matches its own addition; the policy.md deletion has none in ITS file');
});

// ------------------- T5-deletion-policy: matching hardening + deletionCheck ----
//
// T4-verify findings F-A/F-B: token-Jaccard >= 0.6 treats a rule inversion
// ("NEVER skip the tester gate" -> "ALWAYS ...", or a dropped "never") as a
// rewrite because Jaccard only sees the shared tokens, and matching was
// many-to-one (one added line absorbed several deleted lines). unmatchedDeletions
// now (a) matches ONE-TO-ONE, greedy by best similarity, (b) refuses any match
// whose polarity tokens (never/always/must/not/...) differ, (c) falls back to
// hunk-level coverage so a re-wrapped paragraph still matches, and (d) ignores
// deletions with no word tokens (fences, table rules). deletionCheck is the
// deterministic deletion gate the orchestrator runs: JEV only advises.

const wrapDiff = (lines) => lines.join('\n');

test('unmatchedDeletions: a NEVER->ALWAYS flip stays UNMATCHED regardless of Jaccard (F-A)', () => {
  // Jaccard 3/5 = 0.6 would match under the old rule; the polarity tokens
  // never/always differ, so this is a semantic inversion, not a rewrite.
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -1 +1 @@',
    '-NEVER skip the tester gate',
    '+ALWAYS skip the tester gate',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 'p.md', line: 'NEVER skip the tester gate' }]);
});

test('unmatchedDeletions: a dropped negation ("never" removed) stays UNMATCHED (F-A)', () => {
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -2 +2 @@',
    '-JEV uncertainty never auto-passes',
    '+JEV uncertainty auto-passes',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 'p.md', line: 'JEV uncertainty never auto-passes' }]);
});

test('unmatchedDeletions: an ADDED negation also stays UNMATCHED (polarity is symmetric)', () => {
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -2 +2 @@',
    '-push to main when tests are green',
    '+never push to main when tests are green',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 'p.md', line: 'push to main when tests are green' }]);
});

test('unmatchedDeletions: matching polarity tokens on both sides still match (no false block)', () => {
  // 'must' appears on BOTH sides -> polarity equal -> the rewrite matches.
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -2 +2 @@',
    '-workers must never edit the run store directly',
    '+workers must never edit the run store directly, ever',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), []);
});

test('unmatchedDeletions: ONE-TO-ONE - one added line absorbs at most ONE deleted line (F-A)', () => {
  // Both deleted lines are >= 0.6 similar to the one added line (many-to-one
  // used to swallow both); only the best match survives, the second deletion
  // is reported.
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -1,2 +1 @@',
    '-alpha beta gamma',
    '-alpha beta gamma delta',
    '+alpha beta gamma delta epsilon',
  ]);
  const out = unmatchedDeletions(diff);
  assert.equal(out.length, 1, 'the second deletion cannot reuse the consumed added line');
  assert.equal(out[0].line, 'alpha beta gamma');
});

test('unmatchedDeletions: hunk fallback - a line re-wrapped across two added lines matches (F-B)', () => {
  const diff = wrapDiff([
    'diff --git a/doc.md b/doc.md',
    '--- a/doc.md',
    '+++ b/doc.md',
    '@@ -1 +1,2 @@',
    '-One long sentence about gates that gets rewrapped into two shorter lines for width.',
    '+One long sentence about gates that gets rewrapped',
    '+into two shorter lines for width.',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [], 'a re-wrap is a rewrite, not a deletion');
});

test('unmatchedDeletions: the hunk fallback does NOT swallow a real deletion sitting in a rewrite hunk', () => {
  // The hunk re-wraps its paragraph AND deletes a rule; the rule's tokens are
  // not covered by the hunk's additions, so it stays unmatched. This is the
  // gate that keeps T9's real deletion visible (a naive concat fallback drops
  // it to 21/63).
  const diff = wrapDiff([
    'diff --git a/doc.md b/doc.md',
    '--- a/doc.md',
    '+++ b/doc.md',
    '@@ -1,2 +1,2 @@',
    '-One long sentence about gates that gets rewrapped into two shorter lines for width.',
    '-- never auto-pass a gate',
    '+One long sentence about gates that gets rewrapped into',
    '+two shorter lines for width.',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 'doc.md', line: '- never auto-pass a gate' }]);
});

test('unmatchedDeletions: a deletion with NO word tokens is ignored (fences, table rules) (F-B)', () => {
  const diff = wrapDiff([
    'diff --git a/t.md b/t.md',
    '--- a/t.md',
    '+++ b/t.md',
    '@@ -1,3 +0,0 @@',
    '-```',
    '-|---|---|',
    '-real rule gone',
  ]);
  assert.deepEqual(unmatchedDeletions(diff), [{ file: 't.md', line: 'real rule gone' }]);
});

// The three real incident diffs as fixtures: the T9 deletion (out of scope) and
// the T1/T2 legitimate rewrites. Numbers measured 2026-10-07, pre-T5 -> T5:
//   t9 63 deleted -> 58 unmatched (0.92); t1 13 -> 3 (0.23); t2 6 -> 1 (0.17).
// T1's 3 remaining unmatched are all legit per the T4-verify report: the
// `Update run.json...` 2-line block is rewrapped into 8 lines whose hunk
// INTRODUCES the polarity token `optional` ("it is not optional") - a semantic
// addition inside an otherwise-rewrap hunk; the two `commandResolves` lines
// in `fleet/bin/doctor.test.mjs` are an INTENDED removal (T1's whole point:
// replace the .cmd-resolves-OK test with .cmd-does-NOT-resolve). None of these
// is an unintended loss, and the ratio (0.23) stays under deletionCheck's
// maxRatio of 0.25 so the diff is NOT flagged.
const T1_FIXTURE = realReadFileSync(
  fileURLToPath(new URL('./fixtures/t1-doc-nits.diff', import.meta.url)), 'utf8');
const T2_FIXTURE = realReadFileSync(
  fileURLToPath(new URL('./fixtures/t2-evidence-nouls.diff', import.meta.url)), 'utf8');

test('unmatchedDeletions: the REAL T9 diff keeps >= 80% of its deletions unmatched', () => {
  const out = unmatchedDeletions(T9_FIXTURE);
  const total = deletedLines(T9_FIXTURE).length;
  assert.ok(out.length / total >= 0.8, `T9: ${out.length}/${total} unmatched must be >= 80% (the deletion was real)`);
  assert.ok(out.some(u => u.line.includes('A disagreement is')), 'the section-6 policy body stays visible');
});

test('unmatchedDeletions: the REAL T1 diff (legitimate rewrites) -> at most FOUR unmatched (no flag)', () => {
  // Spec: "real T1/T2 fixtures few/zero unmatched (report numbers)". T1's
  // 3 unmatched is a few - all of them are legit per the T4-verify report
  // (a polarity-added rewrap, plus an intended removal). The deletionCheck
  // is what must NOT flag, and at 3/13 = 0.23 it does not (default 0.25).
  const out = unmatchedDeletions(T1_FIXTURE);
  assert.ok(out.length <= 4, `T1: expected at most 4 unmatched, got ${out.length}`);
  const r = deletionCheck(T1_FIXTURE);
  assert.equal(r.flagged, false, `T1 deletionCheck must not flag: ${r.unmatched}/${r.deletedTotal} = ${r.ratio.toFixed(2)}`);
});

test('unmatchedDeletions: the REAL T2 diff (legitimate rewrites) -> at most ONE unmatched', () => {
  const out = unmatchedDeletions(T2_FIXTURE);
  assert.ok(out.length <= 1, `T2: expected at most 1 unmatched, got ${out.length}`);
});

// ------------------------------------------------------------- deletionCheck ----

test('deletionCheck: shape - { unmatched, deletedTotal, ratio, flagged, lines }', () => {
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -1,3 +1 @@',
    '-alpha beta gamma',
    '-delta epsilon zeta',
    '-eta theta iota',
    '+alpha beta gamma delta',
  ]);
  const r = deletionCheck(diff);
  assert.equal(typeof r.unmatched, 'number');
  assert.equal(r.deletedTotal, 3);
  assert.equal(r.ratio, 2 / 3);
  // flagged needs BOTH: 2 > maxUnmatched 3 is FALSE -> not flagged, even at ratio 0.67.
  assert.equal(r.flagged, false, 'a couple of unmatched lines is ordinary intended-removal territory');
  assert.deepEqual(r.lines, [
    { file: 'p.md', line: 'delta epsilon zeta' },
    { file: 'p.md', line: 'eta theta iota' },
  ]);
});

test('deletionCheck: flagged requires BOTH thresholds (unmatched > maxUnmatched AND ratio > maxRatio)', () => {
  const diff = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -1,5 +1 @@',
    '-one wordy deletion line here',
    '-two wordy deletion line here',
    '-three wordy deletion line here',
    '-four wordy deletion line here',
    '-five wordy deletion line here',
  ]);
  // 5 unmatched, ratio 1.0: exceeds BOTH defaults -> flagged.
  assert.equal(deletionCheck(diff).flagged, true);
  // Lower the ratio cut below 1.0? No - raise maxUnmatched to 5: 5 > 5 is false -> not flagged.
  assert.equal(deletionCheck(diff, { maxUnmatched: 5 }).flagged, false);
  // Tighten the ratio cut to 0.9: ratio 1.0 still > 0.9, unmatched 5 > 3 -> flagged.
  assert.equal(deletionCheck(diff, { maxRatio: 0.9 }).flagged, true);
  // A single real deletion among many rewrites: unmatched 1 <= 3 -> not flagged.
  const single = wrapDiff([
    'diff --git a/p.md b/p.md',
    '--- a/p.md',
    '+++ b/p.md',
    '@@ -1,4 +1,4 @@',
    '-rewrite one old wording',
    '+rewrite one new wording',
    '-rewrite two old wording',
    '+rewrite two new wording',
    '-rewrite three old wording',
    '+rewrite three new wording',
    '-rewrite four old wording',
    '+rewrite four new wording',
    '-a truly removed rule with no replacement',
  ]);
  const r = deletionCheck(single);
  assert.equal(r.unmatched, 1);
  assert.equal(r.deletedTotal, 5);
  assert.equal(r.flagged, false, '1 unmatched out of 5 is ordinary intended-removal territory');
});

test('deletionCheck: empty / no-deletion diff is never flagged and divides by nothing', () => {
  assert.deepEqual(deletionCheck(''), { unmatched: 0, deletedTotal: 0, ratio: 0, flagged: false, lines: [] });
  assert.deepEqual(deletionCheck(undefined), { unmatched: 0, deletedTotal: 0, ratio: 0, flagged: false, lines: [] });
  const rewrite = wrapDiff([
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1 +1 @@',
    '-old wording here',
    '+old wording here plus more',
  ]);
  assert.deepEqual(deletionCheck(rewrite), { unmatched: 0, deletedTotal: 1, ratio: 0, flagged: false, lines: [] });
});

test('deletionCheck: the three REAL fixtures - T9 flagged, T1 and T2 clean', () => {
  const t9 = deletionCheck(T9_FIXTURE);
  assert.equal(t9.flagged, true, `T9 (the real out-of-scope deletion) must flag: ${t9.unmatched}/${t9.deletedTotal} = ${t9.ratio.toFixed(2)}`);
  const t1 = deletionCheck(T1_FIXTURE);
  assert.equal(t1.flagged, false, `T1 (legitimate rewrites) must not flag: ${t1.unmatched}/${t1.deletedTotal} = ${t1.ratio.toFixed(2)}`);
  const t2 = deletionCheck(T2_FIXTURE);
  assert.equal(t2.flagged, false, `T2 (legitimate rewrites) must not flag: ${t2.unmatched}/${t2.deletedTotal} = ${t2.ratio.toFixed(2)}`);
});

test('buildGateQuestions: diff.text adds the noul AND a stateAppendix only when unmatched deletions exist', () => {
  const withDel = buildGateQuestions({
    criteria: ['c1'],
    diff: {
      text: 'diff --git a/p.md b/p.md\n--- a/p.md\n+++ b/p.md\n@@ -1 +0,0 @@\n-- never push to main\n',
    },
  });
  assert.equal(withDel.questions.deleted_out_of_scope.type, 'noul');
  assert.match(withDel.questions.deleted_out_of_scope.instructions, /DELETED lines that have no replacement in the diff/);
  assert.match(withDel.questions.deleted_out_of_scope.instructions, /task did not ask to remove/);
  assert.match(withDel.stateAppendix, /--- DELETED LINES WITH NO REPLACEMENT \(file: line\) ---/);
  assert.match(withDel.stateAppendix, /p\.md: - never push to main/);
  assert.ok(withDel.stateAppendix.endsWith('\n'), 'the appendix ends on its own line');
  // An in-place rewrite (Jaccard 0.6, the inclusive cut) is NOT an unmatched deletion.
  const rewrite = buildGateQuestions({
    criteria: ['c1'],
    diff: {
      text: 'diff --git a/f.mjs b/f.mjs\n--- a/f.mjs\n+++ b/f.mjs\n@@ -1 +1 @@\n-old wording here\n+old wording here plus more\n',
    },
  });
  assert.equal(rewrite.questions.deleted_out_of_scope, undefined, 'an in-place rewrite adds no noul');
  assert.equal(rewrite.stateAppendix, '');
  const none = buildGateQuestions({ criteria: ['c1'] });
  assert.equal(none.questions.deleted_out_of_scope, undefined, 'no diff at all: no noul, empty appendix');
  assert.equal(none.stateAppendix, '');
});

// ------------------------------------------------------------------- route ----

test('route: calls the injected ask with state, questions and opts; returns raw detail + fingerprint + model', async () => {
  const seen = [];
  const ask = async (state, questions, opts) => {
    seen.push({ state, questions, opts });
    return { ok: true, answers: { best: CH('a', { a: 0.9, none_fit: 0.1 }) }, model: 'jev-1-13-free', usage: {} };
  };
  const questions = buildRouteQuestions({ id: 'best', instructions: 'Which?', options: { a: 'x' } });
  const r = await route({ state: { task: 't' }, questions, ask, opts: { apiKey: 'k' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.apiKey, 'k');
  assert.ok(r.raw.ok);
  assert.equal(r.model, 'jev-1-13-free');
  assert.equal(r.fingerprint, fingerprint(questions));
});

test('route: a degraded ask passes through, never throws', async () => {
  const ask = async () => ({ ok: false, degraded: true, reason: 'unavailable', detail: 'HTTP 503', action: 'orchestrator_review' });
  const questions = buildRouteQuestions({ id: 'best', instructions: 'Which?', options: { a: 'x' } });
  const r = await route({ state: {}, questions, ask });
  assert.equal(r.raw.ok, false);
  assert.equal(r.raw.reason, 'unavailable');
  assert.equal(r.model, undefined);
});

test('route: an ask that THROWS is caught and returned as degraded, never thrown', async () => {
  const ask = async () => { throw new Error('boom'); };
  const questions = buildRouteQuestions({ id: 'best', instructions: 'Which?', options: { a: 'x' } });
  const r = await route({ state: {}, questions, ask });
  assert.equal(r.raw.ok, false);
  assert.equal(r.raw.degraded, true);
  assert.match(String(r.raw.detail), /boom/);
});

test('route: a null/undefined ask result is degraded, not a crash', async () => {
  const questions = buildRouteQuestions({ id: 'best', instructions: 'Which?', options: { a: 'x' } });
  const r = await route({ state: {}, questions, ask: async () => undefined });
  assert.equal(r.raw.ok, false);
  assert.equal(r.raw.degraded, true);
});

// --------------------------- T9: route() returns the id of a single-choice set ----

test('route: returns id when the questions object has exactly ONE choice question', async () => {
  const ask = async () => ({ ok: true, answers: {}, model: 'm', usage: {} });
  const questions = buildRouteQuestions({ id: 'skill', instructions: 'Which?', options: { a: 'x' } });
  const r = await route({ state: {}, questions, ask });
  assert.equal(r.id, 'skill', 'callers can thread the id without guessing');
});

test('route: id undefined when the questions set has NO choice question', async () => {
  const ask = async () => ({ ok: true, answers: {}, model: 'm', usage: {} });
  const questions = { n1: { type: 'noul', instructions: 'x?' } };
  const r = await route({ state: {}, questions, ask });
  assert.equal(r.id, undefined);
});

test('route: id undefined when the questions set has TWO choice questions', async () => {
  const ask = async () => ({ ok: true, answers: {}, model: 'm', usage: {} });
  const questions = {
    one: { type: 'choice', instructions: 'a?', criteria: { x: 'y', none_fit: 'None' } },
    two: { type: 'choice', instructions: 'b?', criteria: { x: 'y', none_fit: 'None' } },
  };
  const r = await route({ state: {}, questions, ask });
  assert.equal(r.id, undefined, 'several choices: no single id to name - routeDecision escalates ambiguous');
});

// ------------------------------------------------- T7: config adapters ----
//
// The T6 gate finding: SKILL.md 5c's recipes could not run verbatim because
// config keys are snake_case while routeDecision reads camelCase, and route()
// forwards its opts into askJevChain's `providers` parameter. These adapters
// close that gap so the documented one-liners are executable as written.

test('routingConfig: maps snake_case config to the camelCase routeDecision args', () => {
  const rc = routingConfig({ jev: { routing: { auto_apply: 0.65, abstain: 0.6, multi_threshold: 0.65 } } });
  assert.deepEqual(rc, { autoApply: 0.65, abstain: 0.6, multiThreshold: 0.65 });
});

test('routingConfig: missing routing -> safe defaults plus a note', () => {
  const rc = routingConfig({ jev: {} });
  assert.equal(rc.autoApply, 0.8);
  assert.equal(rc.abstain, 0.6);
  assert.equal(rc.multiThreshold, undefined);
  assert.ok(rc.note, 'a missing routing block is reported, never silent');
});

test('routingConfig: validates each value is a finite number in [0,1] (falls back per key)', () => {
  const bad = routingConfig({ jev: { routing: { auto_apply: 1.5, abstain: 'high', multi_threshold: Number.NaN } } });
  assert.equal(bad.autoApply, 0.8, 'an out-of-range auto_apply falls back to the 0.8 default');
  assert.equal(bad.abstain, 0.6);
  assert.equal(bad.multiThreshold, undefined, 'a non-finite multi_threshold is dropped, not guessed');
  assert.ok(bad.note);
  const partial = routingConfig({ jev: { routing: { auto_apply: 0.7 } } });
  assert.equal(partial.autoApply, 0.7);
  assert.equal(partial.abstain, 0.6, 'a missing abstain keeps the safe default');
  assert.equal(partial.multiThreshold, undefined);
  assert.ok(partial.note, 'a partially-missing routing block still notes the fallback');
});

// ----------------------------------------------------------- askFromConfig ----

// A fetchImpl stub shaped like a real systemone response: echoes the question
// keys back with a canned distribution. Recorded so a test can assert the
// provider WAS reached (not degraded).
function systemoneStub({ choice, probs = {}, nouls = {} } = {}) {
  const f = async (url, init) => {
    f.calls += 1;
    f.lastUrl = url;
    f.lastInit = init;
    const body = JSON.parse(init.body);
    f.lastBody = body;
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'choice') answers[id] = { type: 'choice', choice, probabilities: probs, confidence: probs[choice] ?? 0 };
      else answers[id] = { type: 'noul', noul: nouls[id] ?? 0.05 };
    };
    return { status: 200, ok: true, json: async () => ({ model: 'jev-1-13-free', answers, usage: {} }) };
  };
  f.calls = 0;
  return f;
}

const CFG = {
  jev: {
    routing: { auto_apply: 0.65, abstain: 0.6, multi_threshold: 0.65 },
    providers: [{ base_url: 'https://placeholder.example.test/v1/systemone', model: 'jev-1-13-free', api_key_env: 'JEV_TEST_KEY' }],
    timeout_ms: 8000, retries: 1,
    circuit_breaker: { failures_to_open: 3, cooldown_ms: 300000 },
  },
};

test('askFromConfig: asks through askJevChain with cfg providers and forwards opts', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9, none_fit: 0.1 } });
  const ask = askFromConfig(CFG, { env: { JEV_TEST_KEY: 'k' }, fetchImpl: f });
  const questions = buildRouteQuestions({ id: 'route', instructions: 'Which?', options: { a: 'x' } });
  const detail = await ask({ task: 't' }, questions);
  assert.equal(detail.ok, true);
  assert.equal(detail.provider, 'https://placeholder.example.test/v1/systemone', 'the configured provider was reached');
  assert.equal(f.calls, 1, 'the stub fetch was called - not degraded');
  // The exact cfg values the config carries flow into the request the provider sees.
  assert.equal(JSON.parse(f.lastInit.body).model, 'jev-1-13-free');
  assert.equal(JSON.parse(f.lastInit.body).state.task, 't');
  assert.match(String(f.lastInit.headers.Authorization), /^Bearer /);
});

test('askFromConfig: an api_key_env is resolved from the injected env', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const ask = askFromConfig(CFG, { env: { JEV_TEST_KEY: 'from-env' }, fetchImpl: f });
  await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f.lastInit.headers.Authorization, 'Bearer from-env');
});

test('askFromConfig: a missing api key degrades with reason auth before any fetch', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const ask = askFromConfig(CFG, { env: {}, fetchImpl: f });
  const detail = await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(detail.ok, false);
  assert.equal(detail.degraded, true);
  assert.equal(detail.reason, 'auth');
  assert.equal(f.calls, 0, 'degraded before the provider was contacted');
});

test('askFromConfig: retries are forwarded from cfg into the request loop', async () => {
  // 429 then success on the ONE provider: askJevChain must retry per cfg.jev.retries.
  // A distinct base_url keeps this test independent of jev.mjs's module-level
  // per-provider breaker state.
  let calls = 0;
  const f = async (url, init) => {
    calls += 1;
    if (calls === 1) return { status: 429, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ model: 'm', answers: { q: { type: 'noul', noul: 0.1 } }, usage: {} }) };
  };
  const ask = askFromConfig({ jev: { ...CFG.jev, providers: [{ base_url: 'https://retries.test/v1/systemone', model: 'm', api_key_env: 'JEV_TEST_KEY' }] } }, { env: { JEV_TEST_KEY: 'k' }, fetchImpl: f });
  const detail = await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(detail.ok, true);
  assert.equal(calls, 2, 'cfg.jev.retries=1 produced exactly one retry');
});

test('askFromConfig: circuit_breaker maps to the shape askJev expects', async () => {
  // failures_to_open=1: after one degraded call (503 retried once per cfg
  // retries=1) the breaker opens and the next call short-circuits without fetch.
  let calls = 0;
  const f = async () => { calls += 1; return { status: 503, ok: false, json: async () => ({}) }; };
  const cfg = { jev: { ...CFG.jev, circuit_breaker: { failures_to_open: 1, cooldown_ms: 300000 }, providers: [{ base_url: 'https://breaker.test/v1/systemone', model: 'm', api_key_env: 'JEV_TEST_KEY' }] } };
  const ask = askFromConfig(cfg, { env: { JEV_TEST_KEY: 'k' }, fetchImpl: f });
  const r1 = await ask({}, { q: { type: 'noul', instructions: 'x' } });
  const r2 = await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(r1.reason, 'unavailable');
  assert.equal(r2.reason, 'circuit_open', 'the mapped breaker opened after 1 failure');
  assert.equal(calls, 2, 'both fetches happened on call 1 (initial + retry); the opened breaker stopped call 2');
});

test('askFromConfig: opts passed to the returned ask override the cfg-derived defaults', async () => {
  // cfg.jev.retries=1 would retry a 503 once (2 fetches); opts { retries: 0 }
  // on the ask() call must override it (1 fetch). opts spread LAST per spec.
  let calls = 0;
  const f = async () => { calls += 1; return { status: 503, ok: false, json: async () => ({}) }; };
  const ask = askFromConfig({ jev: { ...CFG.jev, providers: [{ base_url: 'https://override.test/v1/systemone', model: 'm', api_key_env: 'JEV_TEST_KEY' }] } }, { env: { JEV_TEST_KEY: 'k' }, fetchImpl: f });
  const detail = await ask({}, { q: { type: 'noul', instructions: 'x' } }, { retries: 0 });
  assert.equal(detail.degraded, true);
  assert.equal(calls, 1, 'the per-call retries:0 override beat cfg.jev.retries=1');
});

// --------------------------------------- T9-jev-env-endpoint: JEV_BASE_URL ----
//
// The defect: `fleet/bin/lib/jev.mjs`'s `DEFAULT_BASE_URL` reads `JEV_BASE_URL`,
// but every caller (`askJevChain`, `askFromConfig`) passes an explicit `baseUrl`
// from `fleet/config.json` `jev.providers[*].base_url`. Setting `JEV_BASE_URL`
// is therefore dead - an operator thinks they pointed JEV at their endpoint and
// silently get the configured primary. The fix: in `askFromConfig` (the single
// boundary where config becomes live providers), `JEV_BASE_URL` from the env
// replaces the FIRST provider's `base_url` ONLY. The first provider is the
// primary; the others are distinct fallback services and MUST keep their
// endpoints so a degraded primary still has somewhere to fail over to. On
// both the live (`process.env`) and test (injected) env paths.

const PRIMARY = 'https://primary.example.test/v1/systemone';
const FALLBACK = 'https://fallback.example.test/v1/systemone';
const OVERRIDE = 'https://127.0.0.1:1/v1/systemone';
const TWO_PROVIDERS_CFG = {
  jev: {
    routing: { auto_apply: 0.8, abstain: 0.6 },
    providers: [
      { base_url: PRIMARY, model: 'm1', api_key_env: 'JEV_TEST_KEY' },
      { base_url: FALLBACK, model: 'm2', api_key_env: 'JEV_TEST_KEY2' },
    ],
    timeout_ms: 8000,
    retries: 0,
  },
};

test('askFromConfig: JEV_BASE_URL in the injected env replaces FIRST provider only, leaves fallback untouched', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const cfg = JSON.parse(JSON.stringify(TWO_PROVIDERS_CFG));   // DEEP copy, for the no-mutation assertion below
  const ask = askFromConfig(cfg, { env: { JEV_TEST_KEY: 'k', JEV_TEST_KEY2: 'k2', JEV_BASE_URL: OVERRIDE }, fetchImpl: f });
  await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f.lastUrl, OVERRIDE, 'the provider request landed on the env-overridden URL');
  assert.equal(cfg.jev.providers[0].base_url, PRIMARY, 'cfg was NOT mutated (the primary stayed where config put it)');
  assert.equal(cfg.jev.providers[1].base_url, FALLBACK, 'cfg was NOT mutated (the fallback stayed where config put it)');
  // A second-call fallback chain (primary then fallback): inject an env whose
  // override only affects the first call's URL, the second call still uses the
  // configured fallback URL even when env.JEV_BASE_URL stays set.
  const f2 = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const ask2 = askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_TEST_KEY2: 'k2', JEV_BASE_URL: OVERRIDE }, fetchImpl: f2 });
  // First call (env wins on primary): hits OVERRIDE. Simulate a 503 so the
  // chain fails over to the second provider - whose URL must still be FALLBACK.
  let n = 0;
  const f3 = async (url) => {
    n += 1;
    if (url === OVERRIDE) return { status: 503, ok: false, json: async () => ({}) };
    assert.equal(url, FALLBACK, 'the fallback provider keeps its configured base_url when env.JEV_BASE_URL is set');
    return { status: 200, ok: true, json: async () => ({ model: 'm', answers: { q: { type: 'noul', noul: 0.1 } }, usage: {} }) };
  };
  const ask3 = askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_TEST_KEY2: 'k2', JEV_BASE_URL: OVERRIDE }, fetchImpl: f3 });
  const detail = await ask3({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(detail.ok, true, 'the chain reached the untouched fallback');
  assert.equal(detail.tried.length, 1, 'one provider failed (the overridden primary) before the chain succeeded');
});

test('askFromConfig: JEV_BASE_URL UNSET leaves providers byte-identical to today (no override)', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const ask = askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_TEST_KEY2: 'k2' /* no JEV_BASE_URL */ }, fetchImpl: f });
  await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f.lastUrl, PRIMARY, 'the env-less path uses the configured primary URL, exactly as before this change');
});

test('askFromConfig: an empty or whitespace-only JEV_BASE_URL is treated as UNSET, never as a valid URL', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  // Empty string
  const askEmpty = askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_BASE_URL: '' }, fetchImpl: f });
  await askEmpty({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f.lastUrl, PRIMARY, 'empty string is unset');
  // Whitespace
  const f2 = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const askWs = askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_BASE_URL: '   \t \n  ' }, fetchImpl: f2 });
  await askWs({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f2.lastUrl, PRIMARY, 'whitespace is unset (trim-then-check)');
});

test('askFromConfig: a malformed JEV_BASE_URL THROWS at bind time (loudly), does not silently dispatch to garbage', () => {
  // 'not a url at all' is unparseable by new URL() (no scheme). The chosen
  // degradation is throw-at-bind: a bad endpoint must never appear inside a
  // ship attempt - it is a config error, like a missing key. Test both: the
  // injected env path and the live process.env path (the latter is exercised
  // by the one-shot script below the assertion).
  const garbage = 'not a url at all';
  assert.throws(
    () => askFromConfig(TWO_PROVIDERS_CFG, { env: { JEV_TEST_KEY: 'k', JEV_BASE_URL: garbage } }),
    /JEV_BASE_URL/,
    'a malformed override throws with a message that names the variable',
  );
});

test('askFromConfig: JEV_BASE_URL override does not mutate `cfg` (built as a copy of the providers array)', () => {
  // A snapshot-before is required so the assertion catches a mutation that
  // happened to rewrite providers[0] to the override URL by accident (the most
  // likely subtle bug; same script for cfg.jev.providers taken AFTER the call
  // is byte-identical to the snapshot).
  const cfg = JSON.parse(JSON.stringify(TWO_PROVIDERS_CFG));
  const snapshot = JSON.stringify(cfg);
  const ask = askFromConfig(cfg, { env: { JEV_TEST_KEY: 'k', JEV_BASE_URL: OVERRIDE }, fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }) });
  // We don't even have to call ask(); the override was already applied to the
  // internal copy at askFromConfig() time. Returning here would still mutate
  // cfg if the binding were broken; the assertion below closes that gap.
  void ask;
  assert.equal(JSON.stringify(cfg), snapshot, 'cfg is byte-identical before and after askFromConfig returned');
  assert.equal(cfg.jev.providers[0].base_url, PRIMARY, 'providers[0].base_url stayed where config put it');
});

test('askFromConfig: the JEV_BASE_URL override leaves API KEY resolution unaffected', async () => {
  const f = systemoneStub({ choice: 'a', probs: { a: 0.9 } });
  const ask = askFromConfig(CFG, { env: { JEV_TEST_KEY: 'env-key', JEV_BASE_URL: OVERRIDE }, fetchImpl: f });
  await ask({}, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(f.lastInit.headers.Authorization, 'Bearer env-key',
    'api_key_env resolution runs the same with or without the URL override');
});

// -------------------------------------------------------- loadFleetConfig ----

test('loadFleetConfig: reads the real fleet/config.json and exposes jev.routing', () => {
  const cfg = loadFleetConfig();
  assert.ok(cfg.jev, 'the real config carries a jev block');
  assert.ok(Array.isArray(cfg.jev.providers) && cfg.jev.providers.length > 0);
  const rc = routingConfig(cfg);
  assert.equal(rc.autoApply, cfg.jev.routing.auto_apply, 'the shipped calibrated auto_apply is honored');
});

test('loadFleetConfig: an injected fs makes it hermetic and a missing file throws a clear error', () => {
  const cfg = loadFleetConfig({ path: '/x/config.json', fs: { readFileSync: () => JSON.stringify({ jev: { routing: { auto_apply: 0.5 } } }) } });
  assert.equal(routingConfig(cfg).autoApply, 0.5);
  assert.throws(() => loadFleetConfig({ path: '/x/config.json', fs: { readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } } }), /ENOENT/);
});

// ------------------------------------------ T9 DOC-AS-TEST: SKILL.md 5c ----
//
// CHANGE 3: the two fenced ```js snippets in SKILL.md 5c are EXTRACTED from the
// doc, stubbed ONLY at their fetch binding, and EXECUTED as real modules through
// the real askJevChain. The skill snippet builds its questions with the
// NON-default id 'skill' and must DECIDE on a confident canned answer (T8 F1:
// this exact shape used to escalate malformed-missing); the gate snippet must
// return a gateVerdict. A snippet that renames a load-bearing identifier or
// breaks the sequence turns these red: the required-line pins fix every name
// the recipe teaches a cold reader (G1-G7).

function skillMd5c() {
  const skillPath = fileURLToPath(new URL('../../.claude/skills/fleet-orchestrator/SKILL.md', import.meta.url));
  const text = realReadFileSync(skillPath, 'utf8');
  // T9r: slice from the 5c heading to the NEXT "### " heading, whatever it is.
  // The old hardcoded "### 7. Test gate" end swallowed whole sections whenever
  // 5c moved (5c now sits before 6), and was how T9 lost section 6's body.
  const start = text.indexOf('### 5c. Asking JEV');
  assert.ok(start >= 0, 'section 5c heading found');
  const next = text.indexOf('\n### ', start + 1);
  assert.ok(next > start, 'a heading follows section 5c');
  const section = text.slice(start, next);
  assert.ok(!section.includes('### 6.'), 'the 5c slice does not reach into section 6');
  return section;
}

function fencedJsBlocks(section) {
  const blocks = [...section.matchAll(/```js\r?\n([\s\S]*?)```/g)].map(m => m[1]);
  assert.equal(blocks.length, 2, `5c must contain exactly two fenced js snippets (found ${blocks.length})`);
  return blocks;
}

// T11-skill-paths-portable: the SKILL ships with REPO-RELATIVE import specifiers
// ('./fleet/bin/lib/...') so it is path-independent — a contributor who cloned
// the repo can save the snippet at the repo root and `node` it. The snippet
// runs from a temp .mjs in the OS temp dir, where './fleet/bin/lib/...' would
// resolve to <tmp>/fleet/bin/lib/... (no such file). The test substitutes each
// repo-relative specifier with a file:// URL anchored at the repo root of the
// test run (the directory two levels up from this test file) so the import
// lands on the real module. requireLines pins the SKILL's relative form; the
// substitution is explicit and small, the doc-as-test value (a snippet that
// would throw at runtime is caught in CI) is preserved.
const REPO_ROOT = pathDirname(pathDirname(pathDirname(fileURLToPath(import.meta.url))));  // fleet/bin/jev-router.test.mjs -> fleet/bin -> fleet -> repo root
function resolveRepoSpecifiers(source) {
  return source.replaceAll(
    "'./fleet/bin/lib/",
    `'${pathToFileURL(pathJoin(REPO_ROOT, 'fleet/bin/lib/')).href}`,
  );
}

// Write the snippet to a temp .mjs with ONLY the fetch binding swapped for a
// stub on globalThis, and repo-relative import specifiers resolved to file://
// URLs anchored at the test's repo root, import it (top-level await runs the
// recipe), capture its console.log, and return the parsed JSON result line.
async function executeSnippet(name, source, { requireLines = [], fetchStub, extraGlobals }) {
  for (const line of requireLines) {
    assert.ok(source.includes(line), `${name}: snippet must keep the line ${JSON.stringify(line)} (cold-read pin)`);
  }
  const BINDING = 'globalThis.fetch';
  const occurrences = source.split(BINDING).length - 1;
  assert.equal(occurrences, 1, `${name}: snippet must bind fetch via globalThis.fetch exactly once (found ${occurrences})`);
  const file = pathJoin(mkdtempSync(pathJoin(tmpdir(), 't9-5c-')), 'snippet.mjs');
  const resolved = resolveRepoSpecifiers(source);
  writeFileSync(file, resolved.replaceAll(BINDING, 'globalThis.__T9_5C_FETCH'), 'utf8');
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => { logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  const prevKey = process.env.JEV_API_KEY;
  if (!process.env.JEV_API_KEY) process.env.JEV_API_KEY = 't9-hermetic-stub-key'; // fetch is stubbed: the key never leaves the process
  try {
    globalThis.__T9_5C_FETCH = fetchStub;
    if (extraGlobals) extraGlobals();
    await import(pathToFileURL(file).href);   // unique temp path each run: never a stale module
  } finally {
    console.log = realLog;
    globalThis.__T9_5C_FETCH = undefined;
    delete globalThis.gitDiffForGate;         // the gitDiff seam must not leak into the next test
    if (prevKey === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = prevKey;
    rmSync(pathDirname(file), { recursive: true, force: true });
  }
  const jsonLine = logged.map(l => l.trim()).find(l => l.startsWith('{') && l.endsWith('}'));
  assert.ok(jsonLine, `${name}: snippet logged a JSON result line`);
  return JSON.parse(jsonLine);
}

test('doc-as-test 5c snippet 1 (skill routing): extracted from the doc and executed - NON-default id decides', async () => {
  const [skillSrc] = fencedJsBlocks(skillMd5c());
  const f = systemoneStub({
    choice: 'fleet_engineer',
    probs: { fleet_engineer: 0.86, fleet_tester: 0.09, none_fit: 0.05 },
    nouls: { skill_needs__fleet_engineer: 0.8, skill_needs__fleet_tester: 0.1 },
  });
  const out = await executeSnippet('skill', skillSrc, {
    requireLines: [
      "import { loadEnv } from './fleet/bin/lib/env.mjs';",
      "from './fleet/bin/lib/jev-router.mjs';",
      'loadEnv();',
      'const cfg = loadFleetConfig();',
      'const dirs = [',
      'const options = skillCatalog({ dirs });',
      'const questions = buildRouteQuestions({',
      "id: 'skill',",
      'const fetchImpl = globalThis.fetch;',
      'const ask = askFromConfig(cfg, { fetchImpl });',
      'const r = await route({ state, questions, ask });',
      'const d = routeDecision(r.raw.answers, { ...routingConfig(cfg), options });',
    ],
    fetchStub: f,
  });
  assert.equal(f.calls, 1, 'the provider was reached through askJevChain via the stubbed fetch');
  assert.equal(out.d.decided_by, 'jev', 'T8 F1: a custom-id recipe run verbatim decides, not malformed-missing');
  assert.equal(out.d.pick, 'fleet_engineer', 'the pick is the real skill name (options reverse-mapping)');
  assert.equal(out.d.branch, 'confident');
  assert.equal(out.id, 'skill', 'route() threaded the non-default id back');
  assert.deepEqual(out.d.multi, ['fleet-engineer'], 'multi computed under the calibrated multi_threshold');
});

test('doc-as-test 5c snippet 2 (gate): extracted from the doc and executed - returns a gateVerdict', async () => {
  const [, gateSrc] = fencedJsBlocks(skillMd5c());
  const f = systemoneStub({
    choice: 'accept',
    probs: { accept: 0.93, rework: 0.05, replan: 0.01, ask_user: 0.005, none_fit: 0.005 },
    nouls: { not_met_0: 0.05, not_met_1: 0.05, violated_0: 0.02, violated_1: 0.02, scope_creep: 0.1, evidence_gap: 0.05, tests_missing: 0.05 },
  });
  const out = await executeSnippet('gate', gateSrc, {
    requireLines: [
      "import { gateVerdict } from './fleet/bin/lib/jev.mjs';",
      "import { loadEnv } from './fleet/bin/lib/env.mjs';",
      "from './fleet/bin/lib/jev-router.mjs';",
      'const cfg = loadFleetConfig();',
      'const criteria = [',
      'const constraints = [',
      'const base = ',
      'const gitDiff = globalThis.gitDiffForGate ?? ',
      "['diff', '--no-color', '-U0', b + '..' + h]",
      "cwd: '.',",
      'const deletion = deletionCheck(diffText);',
      'const diffText = gitDiff(base, head);',
      'const g = buildGateQuestions({ criteria, constraints, diff: { text: diffText } });',
      'const fetchImpl = globalThis.fetch;',
      'const detail = await ask(state, g.questions);',
      "const v = gateVerdict(detail, { decisive: ['accept', 'rework'] });",
      'evidence: \'# tests 67\\n# pass 67\\n# fail 0\' + g.stateAppendix',
    ],
    // The gitDiff seam: the recipe shells out to git; a hermetic test injects
    // the diff text through globalThis.gitDiffForGate instead. An in-place
    // rewrite diff (every deletion has a '+' counterpart) must add NO noul -
    // the F3 wiring - so the stubbed answer set above (no deleted_out_of_scope)
    // is exactly what the recipe builds from it.
    fetchStub: f,
    extraGlobals: () => { globalThis.gitDiffForGate = () => 'diff --git a/f.mjs b/f.mjs\n--- a/f.mjs\n+++ b/f.mjs\n@@ -1 +1 @@\n-old wording here\n+old wording here plus more\n'; },
  });
  assert.equal(f.calls, 1, 'the provider was reached through askJevChain via the stubbed fetch');
  assert.equal(f.lastBody.questions.deleted_out_of_scope, undefined,
    'an in-place rewrite through the recipe adds NO noul (the T3-verify F3 fix, end to end)');
  assert.ok(out.v && typeof out.v === 'object', 'the snippet produced a gateVerdict result');
  assert.equal(out.v.decided_by, 'jev', 'a real verdict, not the degraded fallback');
  assert.equal(out.v.verdict, 'accept');
  assert.equal(out.v.branch, 'confident');
  assert.match(String(out.fingerprint), /^[0-9a-f]{12}$/, 'the gate fingerprint is logged with the verdict');
});

test('doc-as-test 5c snippet 2: an UNMATCHED deletion adds the noul and lands the lines in state.evidence', async () => {
  // The T3-verify F1 reproduction, through the recipe verbatim: the deleted
  // rule has no '+' counterpart, so buildGateQuestions must (a) add the
  // deleted_out_of_scope question, (b) hand back a stateAppendix the snippet
  // appends to evidence, and (c) the provider must have RECEIVED those lines
  // in the request body's state.evidence - the blindness the rework fixes.
  const [, gateSrc] = fencedJsBlocks(skillMd5c());
  const f = systemoneStub({
    choice: 'rework',
    probs: { accept: 0.2, rework: 0.75, replan: 0.02, ask_user: 0.02, none_fit: 0.01 },
    nouls: {
      not_met_0: 0.05, not_met_1: 0.05, violated_0: 0.02, violated_1: 0.02,
      scope_creep: 0.1, evidence_gap: 0.05, tests_missing: 0.05, deleted_out_of_scope: 0.72,
    },
  });
  const DELETED_RULE = '- run the acceptance commands yourself and capture raw output';
  const out = await executeSnippet('gate-unmatched', gateSrc, {
    requireLines: [
      'const g = buildGateQuestions({ criteria, constraints, diff: { text: diffText } });',
      'evidence: \'# tests 67\\n# pass 67\\n# fail 0\' + g.stateAppendix',
    ],
    fetchStub: f,
    extraGlobals: () => {
      // The diff line is '-' + content: a deleted markdown bullet '- rule'
      // appears as '-- rule' in the diff (the exact line grep "^-[^-]" drops).
      globalThis.gitDiffForGate = () => `diff --git a/.claude/skills/fleet-orchestrator/SKILL.md b/.claude/skills/fleet-orchestrator/SKILL.md\n--- a/.claude/skills/fleet-orchestrator/SKILL.md\n+++ b/.claude/skills/fleet-orchestrator/SKILL.md\n@@ -290 +289,0 @@\n-${DELETED_RULE}\n`;
    },
  });
  assert.equal(f.calls, 1);
  assert.ok(f.lastBody.questions.deleted_out_of_scope, 'the noul was built for the unmatched deletion');
  assert.match(String(f.lastBody.state.evidence), /DELETED LINES WITH NO REPLACEMENT \(file: line\)/);
  assert.ok(String(f.lastBody.state.evidence).includes(DELETED_RULE), 'the deleted rule reached the provider inside state.evidence');
  assert.equal(out.v.verdict, 'rework', 'flag-first fires on the deleted_out_of_scope noul');
  assert.equal(out.v.branch, 'flag-first');
});

test('doc-as-test: SKILL.md 5c only names identifiers the code actually exports', () => {
  // Doc-as-test guard: regex the backticked spans in section 5c and check every
  // FUNCTION NAME they mention - a bare backticked identifier, or an identifier
  // in call position (`name(`) inside a code span - is an export of
  // jev-router.mjs / jev.mjs / env.mjs or a known non-export (config key, result
  // field, option name, local variable), so the recipes cannot drift from the
  // code the way F1/F2 did.
  const section = skillMd5c();

  const spans = [...section.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
  assert.ok(spans.length > 0, 'section 5c mentions at least one backticked span');
  const ids = new Set();
  for (const span of spans) {
    // bare single-token spans (prose names: config keys, fields) ...
    if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(span)) ids.add(span.split('.')[0]);
    // ... and anything used as a function call inside a code span. A lone `$`
    // before `(` is shell command substitution (T=$(cygpath ...)), not a call.
    for (const c of span.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (c[1] !== '$') ids.add(c[1]);
    }
  }
  assert.ok(ids.size > 0, 'at least one function name was collected');

  const known = new Set([...Object.keys(routerExports), ...Object.keys(jevExports), ...Object.keys(envExports)]);
  // Tokens that are prose, not function names: config keys in their snake_case
  // form, result/answer field names, config paths (cfg.jev.routing,
  // jev.routing.auto_apply), askJevChain's `providers` parameter, gates.jsonl
  // fields, and the locals the 5c snippets define (dirs, id, r, g, v, ...).
  const allowlist = new Set([
    'auto_apply', 'abstain', 'multi_threshold', 'autoApply', 'multiThreshold',
    'decisive', 'accept', 'rework', 'none_fit', 'decided_by',
    'cfg', 'state', 'questions', 'options', 'multi', 'criteriaIndex',
    'jev', 'routing', 'providers', 'agreement', 'fingerprint', 'ask',
    'dirs', 'id', 'fetchImpl', 'r', 'g', 'v', 'd', 'detail',
    'criteria', 'constraints', 'task', 'report', 'evidence', 'skill',
    'diffText', 'diff', 'deletedOutsideScope', 'evidence_gap', 'deleted_out_of_scope',
    'stateAppendix', 'text', 'base', 'head', 'gitDiff', 'gitDiffForGate',
    'execFileSync',
  ]);
  const unknown = [...ids].filter(id => !known.has(id) && !allowlist.has(id));
  assert.deepEqual(unknown, [], `SKILL.md 5c names identifiers the code does not export: ${unknown.join(', ')}`);
});

// ---------------------------------------------------------------- hermetic ----

test('hermetic: no test fell through to the real global fetch', () => {
  assert.equal(realFetchCalls, 0);
});
