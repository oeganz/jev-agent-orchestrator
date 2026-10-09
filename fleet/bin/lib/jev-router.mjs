// T5-jev-router: dynamic JEV routing. Pure question builders + one thin async
// caller. JEV (see jev.mjs) is a calibrated ROUTER: give it options with real
// descriptions and it returns probabilities. This module builds those question
// sets AT DECISION TIME from live descriptions (skill SKILL.md frontmatter,
// task acceptance criteria), so the wording is always the real one and the
// fingerprint lets a threshold be calibrated per wording.
//
// Layer contract (config jev.routing):
//   skill routing  - choice over skillCatalog(), decided by routeDecision()
//   gate routing   - buildGateQuestions() + jev.mjs gateVerdict() (decider)
//   mechanism/tool - ADVISORY ONLY for now (uncalibrated); orchestrator decides
//
// Every JEV call goes through an injected ask (askJev/askJevChain) so tests are
// hermetic. Nothing here touches the network or the filesystem directly - fs is
// injectable into skillCatalog.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askJevChain } from './jev.mjs';

// JEV limit: a choice with too many options degrades; refuse loudly instead.
export const MAX_CHOICE_OPTIONS = 255;

// ------------------------------------------------------------------ keys ----

// Choice criteria keys must be plain [a-z0-9_] for the provider; routeDecision
// can reverse-map a sanitised key to the ORIGINAL option name when the caller
// passes the options object.
function sanitiseKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// ------------------------------------------------------------ fingerprint ----

// Stable short hash of a questions object. Keys are sorted at every level so
// two question sets that differ ONLY in key order fingerprint identically,
// while any wording change produces a different fingerprint - a threshold is
// calibrated per wording, so the wording must be part of the identity.
export function fingerprint(questions) {
  return createHash('sha256').update(JSON.stringify(canonical(questions))).digest('hex').slice(0, 12);
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

// ----------------------------------------------------------- skillCatalog ----

// Read <dir>/<name>/SKILL.md frontmatter description for every skill dir.
// Earlier dirs win on duplicate names (pass the repo dir first), matching the
// demo's precedence. Only single-line `description: ...` values are used - a
// folded/multi-line YAML description is skipped rather than mis-read as a
// continuation line. Returns { name: description }.
export function skillCatalog({ dirs, fs = { readdirSync, readFileSync } } = {}) {
  const skills = {};
  for (const d of dirs ?? []) {
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }   // missing dir: nothing from it
    for (const entry of entries) {
      let text;
      try { text = fs.readFileSync(join(d, entry, 'SKILL.md'), 'utf8'); } catch { continue; }
      const m = text.match(/^description:[ \t]*(.+)$/m);
      // A YAML block-scalar indicator (>- folded, | literal) means the
      // description is multi-line; lifting it would mis-read the indicator as
      // the description. Skip such skills rather than present garbage.
      if (!m || /^[>|]/.test(m[1].trim())) continue;
      if (!(entry in skills)) skills[entry] = m[1].trim().slice(0, 400);
    }
  }
  return skills;
}

// ------------------------------------------------------ buildRouteQuestions ----

// One `choice` over the options (+ none_fit, always), and when multi=true one
// `noul` per option ("Does this task need <name>: <description>?"). The noul
// threshold is NOT set here - it is calibrated (see jev-route-calibrate.mjs)
// and lives in config jev.routing.multi_threshold; a per-option noul measured
// 2026-10-07 under-fires at 0.55 on 2 of 3 tasks, so multi needs its own cut.
// Enforces the JEV limits: choice criteria is an OBJECT, <=255 caller options.
export function buildRouteQuestions({ id = 'route', instructions = 'Which single option should handle this task?', options, multi = false } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('buildRouteQuestions: options must be an object of { name: description }');
  }
  const names = Object.keys(options);
  if (names.length > MAX_CHOICE_OPTIONS) {
    throw new Error(`buildRouteQuestions: ${names.length} options exceeds the JEV choice limit of ${MAX_CHOICE_OPTIONS} (before none_fit)`);
  }
  const questions = {};

  const criteria = {};
  for (const name of names) criteria[sanitiseKey(name)] = options[name];
  criteria.none_fit = 'None of these fit';
  questions[id] = { type: 'choice', instructions, criteria };

  if (multi) {
    for (const name of names) {
      questions[`${id}_needs__${sanitiseKey(name)}`] = {
        type: 'noul',
        instructions: `Does this task need ${name}: ${options[name]}?`,
      };
    }
  }
  return questions;
}

// ------------------------------------------------------------ routeDecision ----

// Turn JEV answers into a routing decision. JEV decides ONLY when confident on
// the CHOSEN option's probability (T4 lesson: never the max over options);
// every malformed / low-confidence / no-match branch escalates with pick null.
// multi = options whose `needs` noul >= multiThreshold (inclusive). There is
// deliberately NO default multiThreshold: it must come from calibrated config,
// otherwise multi is null with multiNote 'multi-uncalibrated' so an uncut
// multi-select can never masquerade as a measured one.
//
// id resolution (T9, fixing T8 finding F1): when `id` is NOT passed, use the
// ONE choice-type answer if the answer set has exactly one - a recipe that
// built its questions with a custom id used to silently escalate
// malformed-missing on a clean 0.86 answer because the default key was
// 'route'. With zero or several choice answers and no id the decision
// escalates malformed-ambiguous-id: never guess between several. An explicitly
// passed id keeps today's strict behaviour (answers[id] or malformed-missing).
export function routeDecision(answers, { id, autoApply = 0.8, abstain = 0.6, multiThreshold, options } = {}) {
  if (id === undefined || id === null) {
    const choiceKeys = Object.entries(answers ?? {})
      .filter(([, v]) => v?.type === 'choice').map(([k]) => k);
    if (choiceKeys.length !== 1) {
      return { pick: null, prob: null, decided_by: 'escalate', branch: 'malformed-ambiguous-id', multi: null };
    }
    id = choiceKeys[0];
  }
  const multiOut = () => {
    if (multiThreshold === undefined || multiThreshold === null) return null;
    const prefix = id + '_needs__';
    const out = [];
    for (const [k, v] of Object.entries(answers ?? {})) {
      if (!k.startsWith(prefix)) continue;
      if (v?.type === 'noul' && typeof v.noul === 'number' && Number.isFinite(v.noul) && v.noul >= multiThreshold) {
        out.push(k.slice(prefix.length));
      }
    }
    // The noul keys are the sanitised ones the provider required; map back to
    // ORIGINAL option names when the caller passes the options object.
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      const orig = Object.fromEntries(Object.keys(options).map(n => [sanitiseKey(n), n]));
      return out.map(k => orig[k] ?? k);
    }
    return out;
  };
  const esc = (branch, extra = {}) => ({ pick: null, prob: null, decided_by: 'escalate', branch, multi: multiOut(), ...extra });

  const a = answers?.[id];
  if (!a) return esc('malformed-missing');
  if (typeof a.choice !== 'string') return esc('malformed-choice');

  const probs = a.probabilities;
  const prob = probs?.[a.choice];
  if (typeof prob !== 'number' || !Number.isFinite(prob) || prob < 0 || prob > 1) {
    return esc('malformed-probability');
  }

  if (a.choice === 'none_fit') return esc('none-fit', { prob });
  if (prob < abstain) return esc('abstain', { prob });
  if (prob < autoApply) return esc('below-auto-apply', { prob });

  const out = { pick: a.choice, prob, decided_by: 'jev', branch: 'confident' };
  const multi = multiOut();
  return multi === null
    ? { ...out, multi: null, multiNote: 'multi-uncalibrated' }
    : { ...out, multi };
}

// -------------------------------------------------------- buildGateQuestions ----

const DEFAULT_GATE_ROUTES = {
  accept: 'Every acceptance criterion is met by the raw evidence and no flag is raised; pick this to let the task proceed',
  rework: 'A specific criterion is unmet or a defect is visible in the raw evidence; pick this to send the task back to the engineer',
  replan: 'The task spec itself is wrong, incomplete or self-contradictory; pick this when the plan must change, not the implementation',
  ask_user: 'A human decision is needed (policy call, irreversible action, or conflicting requirements); pick this to stop and ask',
};

// One noul per acceptance criterion (not_met_<i>) and per constraint
// (violated_<i>), the three core nouls, and a route choice. This replaces the
// single holistic "any criterion unmet?" noul: measured 2026-10-07
// (g2-T4-per-criterion.mjs), per-criterion nouls pinpointed WHICH criterion
// lacked evidence (0.56) while the criterion text lands verbatim in the
// question. criteriaIndex maps each flag key back to its text so the caller
// can name the failing criterion.
//
// ROUTE -> gateVerdict mapping (the decision stays in jev.mjs gateVerdict):
// pass gateVerdict `decisive: ['accept', 'rework']` - only those are gate
// DECISIONS. 'replan' and 'ask_user' are real ACTIONS but not gate decisions:
// they surface as gateVerdict's non-decisive branch and escalate to the
// orchestrator, which then takes the action. Never widen `decisive` to include
// them - a replan decided silently by JEV is exactly what escalation is for.
//
// evidence_gap is SCOPED TO ACCEPTANCE CRITERIA (T2-evidence-nouls). The prior
// generic wording ("Does the report claim results that the raw evidence pasted
// in state does not show?") fired on clean work - measured 2026-10-07:
// 0.63/0.73/0.69 (T7), 0.75 (T9), 0.47 (T1) - while every per-criterion noul
// was <= 0.20 and the orchestrator reproduced every criterion. It reacted to the
// NUMBER of side claims a long report carries (TDD narrative, design notes) that
// no evidence could ever show; a 6KB report scored 0.26. The key stays
// `evidence_gap` so gates.jsonl rows remain comparable; the wording change moves
// the fingerprint, which is the point (a threshold is calibrated per wording).
//
// deleted_out_of_scope is added ONLY when the caller passes a `diff` with real
// deletions that have NO replacement (T2r-unmatched-deletions; T9 shipped a
// 41-line deletion outside scope and the constraint noul scored 0.12 - the
// deletion was invisible to the nouls). T3-verify findings F1-F3 killed the
// first wiring: the recipe never pasted the lines into the state (live: 0.16),
// the documented `grep "^-[^-]"` dropped every deleted markdown bullet (a
// deleted "- rule" is the diff line "-- rule"; on the real T9 diff it lost 17
// of 71 deletions, including the section-6 ALWAYS rules), and passing ALL
// deletions put in-place rewrites in the uncertain band (0.46). Now the caller
// passes the RAW `git diff -U0 <base>..<head>` text; parseDiff()/deletedLines()
// below read the real structure, unmatchedDeletions() drops every deletion with
// a similar-enough addition in the same file (deterministic code, never a JEV
// question), and buildGateQuestions returns a `stateAppendix` block the caller
// appends to state.evidence so the noul actually has the lines to read.

// Parse a unified diff into per-file { file, deleted, added, binary } entries.
// A new file starts at `diff --git a/X b/Y`; `--- `/`+++ ` lines are headers
// ONLY in the preamble before that file's first `@@`; inside hunks every line
// starting with '-' is a deletion whose content is everything after exactly
// ONE '-' (so a deleted line whose content begins '--' - an SQL comment, a
// YAML `---`, a deleted markdown bullet '- rule' - is kept, not mistaken for a
// header). CRLF-safe. "\ No newline" markers (lines starting with a bare '\')
// and binary notices are ignored; a binary file records binary: true.
export function parseDiff(diffText) {
  const files = [];
  let cur = null;      // current file entry
  let inHunk = false;  // seen this file's first @@?
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { file: m ? m[1] : raw.slice('diff --git '.length), deleted: [], added: [], binary: false };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;                    // preamble before the first file
    if (!inHunk) {
      // File-scope preamble: ---/+++ headers, index/mode/rename lines, binary
      // notices. None of it is content.
      if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') cur.binary = true;
      if (raw.startsWith('@@')) inHunk = true;
      continue;
    }
    if (raw.startsWith('\\')) continue;    // "\ No newline at end of file"
    if (raw.startsWith('-')) cur.deleted.push(raw.slice(1));
    else if (raw.startsWith('+')) cur.added.push(raw.slice(1));
    // context lines (' ' or empty) are neither
  }
  return files;
}

// Flat deleted-line list across every file, in order. Blank deletions (the
// diff line was exactly '-') are dropped: deleting whitespace is noise, not a
// signal, and used to add the noul on otherwise-clean diffs.
export function deletedLines(diffText) {
  const out = [];
  for (const f of parseDiff(diffText)) for (const line of f.deleted) if (line !== '') out.push(line);
  return out;
}

// Deletions with NO replacement: a deleted line is UNMATCHED when no added line
// in the SAME hunk is a plausible rewrite of it. T5-deletion-policy hardened the
// match after T4-verify findings F-A/F-B (the old same-file token-Jaccard filter
// treated "NEVER skip the tester gate" -> "ALWAYS skip the tester gate" as a
// rewrite and let one added line absorb many deleted lines):
//   (a) ONE-TO-ONE matching - each added line absorbs at most ONE deleted line,
//       greedily by best similarity (ties broken by diff order);
//   (b) polarity guard - if the deleted and added line differ in any polarity
//       token (never/always/must/not/no/don't/cannot/only/required/optional/
//       forbidden/allowed) they do NOT match regardless of Jaccard: a flipped
//       or dropped negation is a semantic inversion, not a rewrite;
//   (c) hunk-level fallback - a deleted line also counts as matched when its
//       tokens are >= similarity covered by the CONCATENATION of its hunk's
//       added lines (a re-wrapped paragraph reappears across several lines),
//       but only when the hunk as a whole looks like a rewrite (>= 80% of ALL
//       its deleted tokens covered) so a real deletion sitting inside a
//       rewrite hunk stays visible - that gate is what keeps the real T9
//       fixture at 92% unmatched instead of 33%;
//   (d) deletions with no word tokens (fences, table rules, '---') are ignored.
// Deterministic - this is a filter, not a judgement: which unmatched deletion is
// out of scope is the JEV noul's job (ADVISORY) plus the orchestrator's
// deletionCheck review, and only then with the lines pasted into the state.
export function unmatchedDeletions(diffText, { similarity = 0.6 } = {}) {
  const out = [];
  for (const h of parseHunks(diffText)) {
    const dels = [], adds = [];
    for (const line of h.deleted) {
      if (line.trim() === '') continue;                    // blank deletion: noise
      const tokens = tokenSet(line);
      if (tokens.size === 0) continue;                     // (d) no word tokens: fence/table rule
      dels.push({ line, tokens, polarity: polarityTokens(tokens) });
    }
    for (const line of h.added) {
      const tokens = tokenSet(line);
      if (tokens.size === 0) continue;
      adds.push({ tokens, polarity: polarityTokens(tokens), used: false });
    }
    // (c) hunk shape: is this hunk a rewrite overall? A hunk whose deleted
    // tokens are largely absent from its added tokens is a deletion block, and
    // the concat fallback must not apply inside it. The polarity check is
    // HUNK-level (added ↔ deleted polarity sets must be EQUAL): adding or
    // dropping a negation anywhere in the hunk is a semantic change, not a
    // re-wrap, and the per-line polOk check below is too one-sided to catch
    // it (a deleted line with no polarity tokens would pass an empty-set
    // subset check against an added hunk that introduced "never" / "always").
    const delAll = new Set(), addAll = new Set(), delPol = new Set(), addPol = new Set();
    for (const d of dels) { for (const t of d.tokens) delAll.add(t); for (const t of d.polarity) delPol.add(t); }
    for (const a of adds) { for (const t of a.tokens) addAll.add(t); for (const t of a.polarity) addPol.add(t); }
    let covered = 0;
    for (const t of delAll) if (addAll.has(t)) covered += 1;
    let polMatch = delPol.size === addPol.size;
    if (polMatch) for (const t of delPol) if (!addPol.has(t)) polMatch = false;
    const hunkIsRewrap = delAll.size > 0 && polMatch && covered / delAll.size >= 0.8;

    // (a)+(b) candidate pairs: similar enough AND same polarity set.
    const pairs = [];
    for (let di = 0; di < dels.length; di++) {
      for (let ai = 0; ai < adds.length; ai++) {
        const j = jaccard(dels[di].tokens, adds[ai].tokens);
        if (j < similarity) continue;
        if (!samePolarity(dels[di].polarity, adds[ai].polarity)) continue;
        pairs.push({ di, ai, j });
      }
    }
    pairs.sort((x, y) => y.j - x.j || x.di - y.di || x.ai - y.ai);
    const matched = new Array(dels.length).fill(false);
    for (const p of pairs) {
      if (matched[p.di] || adds[p.ai].used) continue;
      matched[p.di] = true;
      adds[p.ai].used = true;
    }

    for (let di = 0; di < dels.length; di++) {
      if (matched[di]) continue;
      if (hunkIsRewrap) {
        // The hunk fallback is for RE-WRAPPED paragraphs - tokens that no
        // single added line covers at the similarity cut, but the hunk as a
        // whole re-emits. If this deleted line WAS a one-to-one candidate
        // (any added line is similar enough AND same polarity), the strict
        // one-to-one matching already considered it; rescue here would
        // silently break the "one added line absorbs at most one deleted
        // line" rule (F-A).
        const isCandidate = adds.some(a =>
          jaccard(dels[di].tokens, a.tokens) >= similarity &&
          samePolarity(dels[di].polarity, a.polarity));
        if (isCandidate) { out.push({ file: h.file, line: dels[di].line }); continue; }
        const d = dels[di];
        let cov = 0;
        for (const t of d.tokens) if (addAll.has(t)) cov += 1;
        let polOk = true;
        for (const t of d.polarity) if (!addPol.has(t)) polOk = false;
        if (polOk && cov / d.tokens.size >= similarity) continue;   // (c) re-wrapped
      }
      out.push({ file: h.file, line: dels[di].line });
    }
  }
  return out;
}

// Unified-diff parse into per-HUNK { file, deleted, added } entries. Same
// header/edge rules as parseDiff (---/+++ are headers only before the first @@
// of a file, a deleted line's content is everything after exactly ONE '-'),
// but keeps hunks separate so matching never reaches across them.
export function parseHunks(diffText) {
  const files = [];
  let cur = null, hunk = null;
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { file: m ? m[1] : raw.slice('diff --git '.length), deleted: [], added: [], binary: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;                    // preamble before the first file
    if (raw.startsWith('@@')) {            // every @@ opens a new hunk (per-file)
      hunk = { file: cur.file, deleted: [], added: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') cur.binary = true;
      continue;
    }
    if (raw.charCodeAt(0) === 92) continue;  // "\ No newline at end of file"
    if (raw.startsWith('-')) hunk.deleted.push(raw.slice(1));
    else if (raw.startsWith('+')) hunk.added.push(raw.slice(1));
  }
  return files.flatMap(f => f.hunks ?? []);
}

// Polarity tokens (T5 F-A): a rule inversion flips one of these while leaving
// the rest of the line identical, which pure token overlap cannot see.
// 'don'/'dont' both appear because the tokenizer splits on non-alphanumerics.
const POLARITY_TOKENS = new Set([
  'never', 'always', 'must', 'not', 'no', 'don', 'dont', 'cannot',
  'only', 'required', 'optional', 'forbidden', 'allowed',
]);

function polarityTokens(tokens) {
  const out = new Set();
  for (const t of tokens) if (POLARITY_TOKENS.has(t)) out.add(t);
  return out;
}

function samePolarity(a, b) {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

function tokenSet(line) {
  return new Set(String(line).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

// Deterministic deletion gate (T5). The JEV deleted_out_of_scope noul is
// ADVISORY (measured 2026-10-07: 0.56 on the real T9 deletion but 0.64 on
// legitimate T1 rewrites - it cannot separate); the deterministic unmatched
// count CAN (T9 58/63 unmatched, T1 0/13, T2 1/6). The orchestrator runs this
// on the raw diff and, when flagged, lists every unmatched line in the gate row
// and confirms each was intended by the task spec - a mandatory orchestrator
// check, not a JEV decision. flagged needs BOTH cuts: a handful of unmatched
// lines at any ratio, or many unmatched lines at a low ratio, is ordinary
// intended-removal territory.
export function deletionCheck(diffText, { maxUnmatched = 3, maxRatio = 0.25 } = {}) {
  const lines = unmatchedDeletions(diffText);
  const deletedTotal = deletedLines(diffText).filter(line => tokenSet(line).size > 0).length;
  const unmatched = lines.length;
  const ratio = deletedTotal === 0 ? 0 : unmatched / deletedTotal;
  return {
    unmatched,
    deletedTotal,
    ratio,
    flagged: unmatched > maxUnmatched && ratio > maxRatio,
    lines,
  };
}

export function buildGateQuestions({
  criteria = [], constraints = [], routes = DEFAULT_GATE_ROUTES,
  diff = {},
} = {}) {
  const questions = {};
  const criteriaIndex = {};
  criteria.forEach((text, i) => {
    const k = `not_met_${i}`;
    questions[k] = { type: 'noul', instructions: `Is this acceptance criterion NOT met by the raw evidence: ${text}?` };
    criteriaIndex[k] = text;
  });
  constraints.forEach((text, i) => {
    const k = `violated_${i}`;
    questions[k] = { type: 'noul', instructions: `Is this constraint violated by the change: ${text}?` };
    criteriaIndex[k] = text;
  });
  questions.scope_creep = { type: 'noul', instructions: 'Does the diff touch files or behaviour outside the task spec ownership?' };
  questions.evidence_gap = { type: 'noul', instructions: 'Does the report claim that an ACCEPTANCE CRITERION is met where the raw evidence pasted in state does not show it? Ignore claims that are not acceptance criteria (design notes, process narrative).' };
  questions.tests_missing = { type: 'noul', instructions: 'Is there no raw test output in the evidence, or does it show failures?' };

  // The deleted-out-of-scope signal (T2r): the caller passes either the RAW
  // diff text (`diff: { text }`, the 5c recipe) or a precomputed list
  // (`diff: { deletedOutsideScope }`, backward compat). The noul exists only
  // when there is an UNMATCHED deletion to assess - an empty list (or a
  // numstat-only/in-place-rewrite diff, where every deletion has a replacement)
  // means there is nothing for it to assess, so it is absent rather than a
  // guaranteed-zero question, and the fingerprint of a diff-less gate is
  // unchanged. When the noul is added, `stateAppendix` carries the lines:
  // the caller appends it to state.evidence (the T3-verify F1 lesson - a noul
  // asked over a state that never saw the lines scored 0.16 on a real defect).
  const deletedOutsideScope = diff?.deletedOutsideScope;
  let unmatched = Array.isArray(deletedOutsideScope) && deletedOutsideScope.length > 0
    ? deletedOutsideScope.filter(l => String(l).trim() !== '').map(line => ({ file: 'the diff', line }))
    : unmatchedDeletions(diff?.text ?? '');
  let stateAppendix = '';
  if (unmatched.length > 0) {
    questions.deleted_out_of_scope = {
      type: 'noul',
      instructions: 'The evidence lists DELETED lines that have no replacement in the diff. Does any of them remove a rule, instruction or behaviour that the task did not ask to remove?',
    };
    criteriaIndex.deleted_out_of_scope = 'lines deleted with no replacement in the diff';
    stateAppendix = '\n--- DELETED LINES WITH NO REPLACEMENT (file: line) ---\n'
      + unmatched.map(u => `${u.file}: ${u.line}`).join('\n') + '\n';
  }

  const names = Object.keys(routes);
  if (names.length > MAX_CHOICE_OPTIONS) {
    throw new Error(`buildGateQuestions: ${names.length} routes exceeds the JEV choice limit of ${MAX_CHOICE_OPTIONS}`);
  }
  const routeCriteria = {};
  for (const name of names) routeCriteria[sanitiseKey(name)] = routes[name];
  routeCriteria.none_fit = 'None of these fit';
  questions.route = { type: 'choice', instructions: 'What should the orchestrator do next with this task?', criteria: routeCriteria };

  return { questions, fingerprint: fingerprint(questions), criteriaIndex, stateAppendix };
}

// ------------------------------------------------------------------- route ----

// Thin async wrapper: call the injected ask (askJev or askJevChain), return
// { raw: detail, fingerprint, model, id } and NEVER throw - a degraded detail
// (the jev.mjs fallback shape) passes straight through for the caller to
// escalate. `id` is the key of the choice question when the set has exactly
// ONE (the common single-choice route), undefined otherwise - callers thread
// it into routeDecision({id}) instead of guessing (T9).
export async function route({ state, questions, ask, opts = {} } = {}) {
  const fp = fingerprint(questions);
  let detail;
  try {
    detail = await ask(state, questions, opts);
  } catch (err) {
    detail = { ok: false, degraded: true, reason: 'threw', detail: String(err?.message || err), action: 'orchestrator_review' };
  }
  if (!detail || typeof detail !== 'object') {
    detail = { ok: false, degraded: true, reason: 'empty', detail: 'ask returned no result', action: 'orchestrator_review' };
  }
  const choiceKeys = Object.values(questions ?? {})
    .filter(q => q?.type === 'choice').length;
  return { raw: detail, fingerprint: fp, model: detail.model, ...(choiceKeys === 1 && { id: singleChoiceKey(questions) }) };
}

function singleChoiceKey(questions) {
  for (const [k, q] of Object.entries(questions ?? {})) if (q?.type === 'choice') return k;
  return undefined;
}

// ---------------------------------------------------------- routingConfig ----
//
// T7-router-wiring (gate finding F1): fleet/config.json keys are snake_case
// (jev.routing.auto_apply / .multi_threshold) while routeDecision() reads
// camelCase (autoApply / multiThreshold). Passing cfg.jev.routing verbatim
// SILENTLY dropped the calibration - the 0.65 cut fell back to the 0.8 default
// and multi was never computed. This adapter maps the keys and validates each
// value, so a doc recipe can hand config straight to the decision function.
const ROUTING_DEFAULTS = { autoApply: 0.8, abstain: 0.6, multiThreshold: undefined };

export function routingConfig(cfg) {
  const routing = cfg?.jev?.routing;
  if (!routing || typeof routing !== 'object') {
    return { ...ROUTING_DEFAULTS, note: 'no jev.routing in config - safe defaults (autoApply 0.8, abstain 0.6, multi uncalibrated)' };
  }
  const out = { autoApply: ROUTING_DEFAULTS.autoApply, abstain: ROUTING_DEFAULTS.abstain, multiThreshold: undefined };
  const notes = [];
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  for (const [snake, camel, dflt, label] of [
    ['auto_apply', 'autoApply', 0.8, 'auto_apply'],
    ['abstain', 'abstain', 0.6, 'abstain'],
  ]) {
    if (routing[snake] === undefined) { notes.push(`${label} missing -> ${dflt}`); continue; }
    if (!valid(routing[snake])) { notes.push(`${label}=${routing[snake]} not a finite number in [0,1] -> ${dflt}`); continue; }
    out[camel] = routing[snake];
  }
  if (routing.multi_threshold === undefined) {
    notes.push('multi_threshold missing -> multi stays uncalibrated (null)');
  } else if (!valid(routing.multi_threshold)) {
    notes.push(`multi_threshold=${routing.multi_threshold} not a finite number in [0,1] -> dropped (multi uncalibrated)`);
  } else {
    out.multiThreshold = routing.multi_threshold;
  }
  return notes.length ? { ...out, note: notes.join('; ') } : out;
}

// ---------------------------------------------------------- askFromConfig ----
//
// T7-router-wiring (gate finding F2/F3): route() forwards its opts into the
// injected ask, but askJevChain's third parameter is `providers` - so the
// documented `route({state, questions, ask: askJevChain})` could never reach a
// provider ("providers is not iterable" -> degraded every call), and a bare
// askJevChain call without providers degrades 'no_providers'. askFromConfig(cfg)
// returns an ask(state, questions, opts) bound to cfg.jev.providers with the
// cfg timeout/retries/breaker keyed as askJev expects (failures_to_open /
// cooldown_ms), so `route({state, questions, ask: askFromConfig(cfg)})` runs.
//
// Key resolution: askJevChain reads process.env[p.api_key_env] ?? p.api_key per
// provider. When an env is injected (tests) the injected env IS the environment,
// so the resolved key is bound into a provider copy (api_key, no api_key_env) -
// process.env is never mutated. On the live path env IS process.env and the
// providers pass through untouched.
//
// JEV_BASE_URL override (T9-jev-env-endpoint): the env var REPLACES the FIRST
// provider's `base_url` when set. The first provider is the primary; the rest
// are distinct fallback services and MUST keep their configured endpoints so a
// degraded primary still has somewhere to fail over to. Empty / whitespace
// values are treated as unset (never a valid URL). A value that fails
// `new URL()` parsing is a CONFIG ERROR and throws at bind time (the operator
// setting a bad endpoint is no different from setting a bad credential - we
// fail loudly, never silently). `cfg` is NEVER mutated: the override is
// applied to a built provider array (the live and injected-env branches take
// the same path when the override is present).
function resolveBaseUrlOverride(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return null;
  try { new URL(trimmed); } catch { throw new Error(`JEV_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`); }
  return trimmed;
}
export function askFromConfig(cfg, { env = process.env, fetchImpl } = {}) {
  const j = cfg?.jev ?? {};
  const configured = Array.isArray(j.providers) ? j.providers : [];
  const override = resolveBaseUrlOverride(env?.JEV_BASE_URL);
  const applyOverride = (p, i) => (i === 0 && override ? { ...p, base_url: override } : p);
  const providers = env === process.env
    ? (override ? configured.map(applyOverride) : configured)
    : configured.map((p, i) => {
        const baseP = applyOverride(p, i);
        if (!baseP?.api_key_env) return baseP;
        const { api_key_env, ...rest } = baseP;
        // ?? null (not undefined): askJev's destructuring default replaces an
        // explicitly-undefined apiKey with process.env.JEV_API_KEY - and this
        // module loads .env at import. An injected env IS the environment, so a
        // key missing from it must degrade 'auth', never silently use the real key.
        return { ...rest, api_key: env[api_key_env] ?? p.api_key ?? null };
      });
  const opts = {
    ...(fetchImpl !== undefined && { fetchImpl }),
    ...(j.timeout_ms !== undefined && { timeoutMs: j.timeout_ms }),
    ...(j.retries !== undefined && { retries: j.retries }),
    ...(j.circuit_breaker && typeof j.circuit_breaker === 'object' && {
      breaker: {
        failures_to_open: j.circuit_breaker.failures_to_open,
        cooldown_ms: j.circuit_breaker.cooldown_ms,
      },
    }),
  };
  return async function ask(state, questions, extra = {}) {
    return askJevChain(state, questions, providers, { ...opts, ...extra });
  };
}

// -------------------------------------------------------- loadFleetConfig ----

// Read fleet/config.json. Accepts a path string or { path, fs } - fs injectable
// so tests never touch the real file. A read/JSON error propagates loudly: a
// config problem must fail visibly, never fall back to silent defaults.
export function loadFleetConfig(pathOrOpts, maybeFs) {
  const opts = typeof pathOrOpts === 'string' ? { path: pathOrOpts, fs: maybeFs } : (pathOrOpts ?? {});
  const fs = opts.fs ?? { readFileSync };
  const p = opts.path ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
