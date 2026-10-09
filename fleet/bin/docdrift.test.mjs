// Tests for fleet/bin/lib/docdrift.mjs - the citation drift detector that
// backs `fleet doc-drift`. Pure where possible: gitCmd and readFn are
// injected so the tests run without touching a real repo. A small fixture
// covers same / moved / gone / unresolvable / CRLF mismatch / --fix / exit
// codes. The suite is skipped with a printed reason if git is unavailable
// (we still depend on git in one CLI smoke test), but no test skips silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  detectDrift,
  docDriftCli,
  __test__ as dt,
} from './lib/docdrift.mjs';

const { parseEvidence, normalize, classifyOne, applyFix, first60, buildSidecar } = dt;

// A doc with four claims - one of each drift class (plus an inferred
// claim, which is skipped). Evidence: CLAUDE.md:N (single-line) and
// src/file.js:N (also single-line). Coverage is the minimum to assert
// parse order; per-class behaviour is exercised by the per-test fixtures
// below.
const SAMPLE = (meta = '') => `<!doctype html><html><head>${meta}
<script type="application/json" id="doc-meta">{"project":"x","doc_version":"1","generated_by":"t","generated_at":"2026-10-08","commit":"abc"}</script>
</head><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:1">code claim</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:2">doc claim</span>
<span class="claim" data-claim="C-3" data-source="inferred">inferred claim</span>
</div></body></html>`;

test('parseEvidence returns {rel, start, end} for path:N', () => {
  const r = parseEvidence('src/a.js:12');
  assert.deepEqual({ rel: r.rel, start: r.start, end: r.end }, { rel: 'src/a.js', start: 12, end: 12 });
});
test('parseEvidence returns range when given path:N-M', () => {
  const r = parseEvidence('src/a.js:10-15');
  assert.deepEqual({ rel: r.rel, start: r.start, end: r.end }, { rel: 'src/a.js', start: 10, end: 15 });
});
test('parseEvidence rejects a line number < 1', () => {
  assert.equal(parseEvidence('src/a.js:0').err, 'line number 0 must be >= 1: src/a.js:0');
});
test('parseEvidence rejects escape sequences and absolute paths', () => {
  assert.match(parseEvidence('../x.js:1').err, /escapes root/);
  assert.match(parseEvidence('/abs/x.js:1').err, /absolute/);
  assert.match(parseEvidence('C:\\x.js:1').err, /absolute/);
});
test('parseEvidence rejects malformed input', () => {
  assert.match(parseEvidence('src/a.js').err, /malformed/);
  assert.match(parseEvidence('src/a.js:abc').err, /malformed/);
});
test('parseEvidence rejects empty input', () => {
  assert.equal(parseEvidence('').err, 'empty evidence');
  assert.equal(parseEvidence(null).err, 'empty evidence');
});

test('normalize strips CR / CRLF to LF', () => {
  assert.equal(normalize('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(normalize(undefined), '');
});

// detectDrift uses classifyOne under the hood; we exercise detectDrift
// through fakes for gitCmd and readFn. The fakes are stateful so we can
// control "base" and "worktree" answers per file.
function fakeStore() {
  // base[path] is the LF text "as it was at <base>". work[path] is the
  // current worktree text. Either may be missing (the fakes throw).
  const base = {};
  const work = {};
  const gitCmd = (args) => {
    // 'git show <sha>:<rel>' - in the fake we IGNORE the sha and look up
    // by file path. The store is keyed on the file path the SUT hands us
    // (so a test that says "file was new at base" by omitting that key is
    // enough to simulate the git show failure).
    const ref = args[1];
    const colon = ref.lastIndexOf(':');
    const p = colon === -1 ? ref : ref.slice(colon + 1);
    if (!(p in base)) { const e = new Error(`fatal: bad file: ${p}`); e.stderr = `fatal: bad file: ${p}`; throw e; }
    return base[p];
  };
  const readFn = (abs) => {
    if (!(abs in work)) throw new Error('test fake: missing worktree entry ' + abs);
    return work[abs];
  };
  // existsFn only mirrors whether the worktree entry is populated -
  // matches the real behaviour (a file is present iff readFn can answer).
  const existsFn = (p) => p in work;
  return { gitCmd, readFn, existsFn, setBase: (p, t) => { base[p] = t; }, setWork: (p, t) => { work[p] = t; } };
}

test('detectDrift returns same when the cited line is byte-identical (after CRLF norm)', () => {
  const fs = fakeStore();
  fs.setBase('src/a.js', 'one\ntwo\nthree\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'one\ntwo\r\nthree\n'); // CRLF worktree
  const html = SAMPLE().replace('data-claim="C-1" data-source="code" data-evidence="src/a.js:1"', 'data-claim="C-1" data-source="code" data-evidence="src/a.js:2"');
  // The above replace leaves C-1 pointing at line 2 in BOTH base and work;
  // we also add a C-2 doc claim whose evidence we will set in store.
  fs.setBase('README.md', 'a\nb\nc\n');
  fs.setWork(path.join('/root', 'README.md'), 'a\nb\nc\n');
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  const c2 = r.claims.find(c => c.id === 'C-2');
  assert.equal(c1.status, 'same', 'CRLF-mismatched line should still classify as same');
  assert.equal(c2.status, 'same');
  assert.equal(r.byStatus.same, 2);
  assert.equal(r.byStatus.moved, 0);
});

test('detectDrift classifies a moved line (insertion above shifts line N down)', () => {
  const fs = fakeStore();
  // base: 3 lines. work: a new line prepended shifts target line 2 -> 3.
  fs.setBase('src/a.js', 'old-base\ntarget\nafter\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'new-prepended\nold-base\ntarget\nafter\n');
  fs.setBase('README.md', 'p\nq\nr\n');
  fs.setWork(path.join('/root', 'README.md'), 'p\nq\nr\n');
  const html = `<!doctype html><html><head>
<script type="application/json" id="doc-meta">{"project":"x","doc_version":"1","generated_by":"t","generated_at":"2026-10-08","commit":"abc"}</script>
</head><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:2">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'moved');
  assert.equal(c1.baseLine, 2);
  assert.equal(c1.newLine, 3);
  assert.match(c1.first, /target/);
  assert.equal(r.byStatus.moved, 1);
  assert.equal(r.byStatus.same, 1);
});

test('detectDrift classifies a gone line (base text rewritten and not present in work)', () => {
  const fs = fakeStore();
  // Base line 2 = "old-target". Work has completely different content.
  fs.setBase('src/a.js', 'alpha\nold-target\nomega\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'alpha\ntotally-different\nomega\n');
  fs.setBase('README.md', 'p\nq\nr\n');
  fs.setWork(path.join('/root', 'README.md'), 'p\nq\nr\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:2">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'gone');
  assert.equal(c1.base, 'old-target');
  assert.equal(r.byStatus.gone, 1);
});

test('detectDrift classifies a new file as unresolvable (not drift)', () => {
  const fs = fakeStore();
  // README.md DOES NOT EXIST in the base (new file added since base).
  // fs.setBase('README.md', ...) deliberately omitted.
  fs.setBase('src/a.js', 'a\nb\nc\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'a\nb\nc\n');
  fs.setWork(path.join('/root', 'README.md'), 'hello\nworld\nthird\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:1">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-2');
  assert.equal(c1.status, 'unresolvable');
  assert.match(c1.reason, /file missing at/);
  // README.md is a brand new file - cite whatever it points at.
  assert.equal(r.byStatus.unresolvable, 1);
});

test('detectDrift classifies a cited line beyond base file length as unresolvable', () => {
  const fs = fakeStore();
  fs.setBase('src/a.js', 'only\n'); // 1 line
  fs.setWork(path.join('/root', 'src/a.js'), 'only\n');
  fs.setBase('README.md', 'p\nq\nr\n');
  fs.setWork(path.join('/root', 'README.md'), 'p\nq\nr\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:99">x</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:2">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'unresolvable');
  assert.match(c1.reason, /beyond base/);
});

test('detectDrift marks inferred claims (no evidence) as same and excludes from total', () => {
  const fs = fakeStore();
  fs.setBase('src/a.js', 'a\nb\nc\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'a\nb\nc\n');
  const r = detectDrift(SAMPLE(), 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c3 = r.claims.find(c => c.id === 'C-3');
  assert.equal(c3.status, 'same');
  // total excludes inferred/evidence-less claims.
  assert.equal(r.total, 2);
});

test('detectDrift classifies a blank base line as gone (a blank is not a valid move anchor)', () => {
  const fs = fakeStore();
  // Base line 2 is blank; worktree line 2 is text. Searching for the empty
  // string would spuriously match the first blank line in the worktree.
  fs.setBase('src/a.js', 'alpha\n\nomega\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'alpha\nnew-text\nomega\n');
  fs.setBase('README.md', 'p\nq\nr\n');
  fs.setWork(path.join('/root', 'README.md'), 'p\nq\nr\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="C-2" data-source="doc"  data-evidence="README.md:2">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'gone');
});

// applyFix: surgical test on the regex used to rewrite data-evidence in
// place. The test claims the new line number for a moved row and asserts
// count + the rewritten attribute.
test('applyFix rewrites only moved rows and leaves gone/same/unresolvable alone', () => {
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="A" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="B" data-source="code" data-evidence="src/a.js:5">x</span>
<span class="claim" data-claim="C" data-source="code" data-evidence="src/a.js:9">x</span>
</div></body></html>`;
  const report = {
    claims: [
      { id: 'A', status: 'moved', baseFile: 'src/a.js', baseLine: 2, newLine: 7 },
      { id: 'B', status: 'same', baseFile: 'src/a.js', baseLine: 5, newLine: 5 },
      { id: 'C', status: 'gone', baseFile: 'src/a.js', baseLine: 9, newLine: null },
    ],
  };
  const { html: out, count } = applyFix(html, report);
  assert.equal(count, 1, 'only A should be rewritten');
  assert.match(out, /data-claim="A"[^>]*data-evidence="src\/a\.js:7"/);
  assert.match(out, /data-claim="B"[^>]*data-evidence="src\/a\.js:5"/);
  assert.match(out, /data-claim="C"[^>]*data-evidence="src\/a\.js:9"/);
});

test('first60 truncates long text and flattens newlines', () => {
  const a = 'x'.repeat(80);
  assert.equal(first60(a).length, 63); // 60 + '...'
  assert.match(first60(a), /\.\.\.$/);
  assert.equal(first60('short'), 'short');
  assert.equal(first60('line1\nline2'), 'line1 line2');
});

// ---------------------------------------------------------------------------
// T6-docdrift-fix: regression suite for the first-match / wrong-rewrite bug.
// The original implementation picked the FIRST occurrence of the base line
// text in the worktree, which silently wrote the wrong line when the text
// recurs. The fix picks the occurrence closest to the citation's current
// line; when two candidates tie, the claim is reported as `ambiguous` and
// --fix refuses to rewrite it.
// ---------------------------------------------------------------------------

test('T6: duplicate text, two occurrences, picks the one nearest the citation', () => {
  const fs = fakeStore();
  // Base line 5 = "the target line". Worktree has the same text at line 3
  // and line 100; the citation is `src/a.js:5` (current value = 5).
  // Distances from 5: |3-5|=2 (closer), |100-5|=95. The fix picks line 3.
  fs.setBase('src/a.js', 'a\nb\nc\nd\nthe target line\nf\ng\nh\ni\nj\n');
  const work = ['a', 'b', 'the target line'];
  for (let i = 3; i < 99; i++) work.push(`pad-${i}`);
  work.push('the target line');
  for (let i = 101; i < 110; i++) work.push(`pad-${i}`);
  fs.setWork(path.join('/root', 'src/a.js'), work.join('\n') + '\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:5">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'moved');
  assert.equal(c1.newLine, 3, 'must pick the closer occurrence, not the first one');
});

test('T6: duplicate text, equidistant, classified ambiguous, NOT rewritten by --fix', () => {
  const fs = fakeStore();
  // Base line 5 = "the target line". Worktree has the same text at line 3
  // and line 7. |3-5|=2, |7-5|=2: equidistant. The classifier refuses
  // to guess and reports `ambiguous` with both candidates. applyFix
  // must leave the claim's evidence unchanged because its status is
  // not 'moved'.
  fs.setBase('src/a.js', 'a\nb\nc\nd\nthe target line\nf\ng\nh\ni\nj\n');
  fs.setWork(path.join('/root', 'src/a.js'),
    'a\nb\nthe target line\nd\ndifferent\nf\nthe target line\nh\ni\nj\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="AMB" data-source="code" data-evidence="src/a.js:5">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const amb = r.claims.find(c => c.id === 'AMB');
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.candidates, [3, 7]);
  assert.equal(r.byStatus.ambiguous, 1);
  // applyFix must NOT rewrite an ambiguous row - status is not 'moved'.
  const { html: out, count, rewritten } = applyFix(html, r);
  assert.equal(count, 0, 'ambiguous claims must not be rewritten');
  assert.equal(rewritten.length, 0);
  assert.equal(out, html, 'the doc is unchanged when the only drift is ambiguous');
});

test('T6: original first-match bug is dead - text at 10 and 400, citation near 400, picks 400 not 10', () => {
  // The original bug: text recurs at line 10 AND line 400. The citation
  // is `src/a.js:401` (current value = 401). The old code took the
  // first match and wrote line 10 - which is unrelated to the citation
  // in a 400-line file. The fix must pick line 400 (distance 1 from
  // 401) over line 10 (distance 391).
  const fs = fakeStore();
  const base = [];
  for (let i = 0; i < 410; i++) base.push(i === 400 ? 'the target line' : `pad-${i}`);
  fs.setBase('src/a.js', base.join('\n') + '\n');
  const work = [];
  for (let i = 0; i < 410; i++) {
    if (i === 9 || i === 399) work.push('the target line');
    else work.push(`pad-${i}`);
  }
  fs.setWork(path.join('/root', 'src/a.js'), work.join('\n') + '\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:401">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'moved');
  assert.equal(c1.newLine, 400, 'proximity must pick the closer occurrence (400), not the first match (10)');
});

test('T6: --fix is idempotent - fix, then fix again, nothing changes', () => {
  // The sidecar is the idempotence mechanism. The first --fix rewrites
  // the citation and writes the sidecar. The second --fix loads the
  // sidecar; classifyOne sees the claim as `same` (its current
  // evidence matches the sidecar's newEvidence and the base is
  // unchanged); applyFix has no `moved` rows; the file is unchanged.
  const fs = fakeStore();
  // No sidecar; the citation is `src/a.js:2` pointing at "target".
  // Base line 2 = "target"; worktree has "target" at line 3 only.
  fs.setBase('src/a.js', 'old-base\ntarget\nafter\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'new-prepended\nold-base\ntarget\nafter\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="C-1" data-source="code" data-evidence="src/a.js:2">x</span>
</div></body></html>`;
  // First pass: detect + fix.
  const r1 = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r1.claims.find(c => c.id === 'C-1');
  assert.equal(c1.status, 'moved');
  assert.equal(c1.newLine, 3);
  const fix1 = applyFix(html, r1);
  assert.equal(fix1.count, 1);
  // Build the sidecar from the first fix (mirrors what the CLI does).
  const sidecar1 = buildSidecar(null, 'any-sha', fix1.rewritten);
  assert.equal(sidecar1.fixes.length, 1);
  assert.equal(sidecar1.fixes[0].claimId, 'C-1');
  assert.equal(sidecar1.fixes[0].newEvidence, 'src/a.js:3');
  // Second pass: with the sidecar loaded, the claim is `same` (the
  // orchestrator already accepted the rewrite against this base).
  const r2 = detectDrift(fix1.html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn, prevSidecar: sidecar1 });
  const c2 = r2.claims.find(c => c.id === 'C-1');
  assert.equal(c2.status, 'same', 'sidecar idempotence: the same-base re-run must be a no-op');
  assert.equal(c2.idempotent, true);
  // A second applyFix has no `moved` rows to process - file unchanged.
  const fix2 = applyFix(fix1.html, r2);
  assert.equal(fix2.count, 0, 'no moved rows on a re-run with a fresh sidecar');
  assert.equal(fix2.html, fix1.html, 'the doc is unchanged on the second --fix');
});

test('T6: ambiguous counts as drift (exit 1)', () => {
  const fs = fakeStore();
  // The same equidistant duplicate-text fixture as the dedicated
  // ambiguous test, but driven through the docDriftCli exit-code path
  // so the byStatus.ambiguous contributes to the drift count.
  fs.setBase('src/a.js', 'a\nb\nc\nd\nthe target line\nf\ng\nh\ni\nj\n');
  fs.setWork(path.join('/root', 'src/a.js'),
    'a\nb\nthe target line\nd\ndifferent\nf\nthe target line\nh\ni\nj\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="AMB" data-source="code" data-evidence="src/a.js:5">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  // Mirror the CLI's exit-code rule: drift = moved + gone + ambiguous.
  const drift = r.byStatus.moved + r.byStatus.gone + r.byStatus.ambiguous;
  assert.ok(drift > 0, 'ambiguous must contribute to the drift count');
  assert.ok(r.byStatus.ambiguous > 0, 'ambiguous must not be silently green');
});

test('T6: --fix leaves a gone citation untouched (the file content is missing, not just shifted)', () => {
  const fs = fakeStore();
  // Base line 2 = "old-target". Worktree has completely different
  // content - the base line text is nowhere in the worktree. The
  // classifier returns `gone`; applyFix must not rewrite the evidence
  // because guessing where the line went is exactly the wrong answer
  // (T6-docdrift-fix protocol: never rewrite a not-exactly-resolvable
  // citation).
  fs.setBase('src/a.js', 'alpha\nold-target\nomega\n');
  fs.setWork(path.join('/root', 'src/a.js'), 'alpha\ntotally-different\nomega\n');
  const html = `<!doctype html><html><body><div id="p" class="page-pane">
<span class="claim" data-claim="GONE" data-source="code" data-evidence="src/a.js:2">x</span>
</div></body></html>`;
  const r = detectDrift(html, 'any-sha', { repoRoot: '/root', gitCmd: fs.gitCmd, readFn: fs.readFn, existsFn: fs.existsFn });
  const c1 = r.claims.find(c => c.id === 'GONE');
  assert.equal(c1.status, 'gone');
  const { html: out, count, rewritten } = applyFix(html, r);
  assert.equal(count, 0, 'gone claims must not be rewritten by --fix');
  assert.equal(rewritten.length, 0);
  assert.equal(out, html, 'the doc is byte-equal to the input');
});

test('T6: buildSidecar dedupes fixes by claimId (newest wins) and discards fixes from a different base', () => {
  // Different base: previous fixes are stale and must be discarded
  // (the orchestrator's protocol: advance the base after --fix).
  const prev = { version: 1, baseSha: 'OLD', fixedAt: 't1', fixes: [{ claimId: 'A', oldEvidence: 'a.js:1', newEvidence: 'a.js:2' }] };
  const next = buildSidecar(prev, 'NEW', [{ claimId: 'B', oldEvidence: 'b.js:3', newEvidence: 'b.js:4' }]);
  assert.equal(next.baseSha, 'NEW');
  assert.equal(next.fixes.length, 1);
  assert.equal(next.fixes[0].claimId, 'B');

  // Same base: previous fixes for a claimId are overwritten by the
  // newest fix; other fixes survive.
  const same = buildSidecar(prev, 'OLD', [{ claimId: 'A', oldEvidence: 'a.js:2', newEvidence: 'a.js:5' }]);
  assert.equal(same.fixes.length, 1);
  assert.equal(same.fixes[0].newEvidence, 'a.js:5', 'newest fix wins for the same claimId');
});

// ------------------- hermetic end-to-end via real git -------------------
//
// Build a tiny real git repo in a tempdir, then exercise the CLI both ways:
// as a Node function (docDriftCli) without subprocess noise, and as one
// subprocess smoke that asserts the script's exit code. SKIP if git is not
// installed - never silently.

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function setupRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'docdrift-repo-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 't'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' });
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'a.js'), 'alpha\ntarget-on-base\nomega\n');
  writeFileSync(path.join(root, 'README.md'), 'p\nq\nr\n');
  const html = `<!doctype html><html><head>
<script type="application/json" id="doc-meta">{"project":"x","doc_version":"1","generated_by":"t","generated_at":"2026-10-08","commit":"abc"}</script>
</head><body><div id="p" class="page-pane">
<span class="claim" data-claim="OK" data-source="code" data-evidence="src/a.js:2">x</span>
<span class="claim" data-claim="DOC" data-source="doc" data-evidence="README.md:2">x</span>
</div></body></html>`;
  writeFileSync(path.join(root, 'docs', 'doc.html'), html);
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'base'], { stdio: 'ignore' });
  const baseSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root, baseSha };
}

const SKIP = !gitAvailable();
(SKIP ? test('SKIP: doc-drift hermetic suite (git unavailable)', { skip: SKIP && 'git not on PATH' }, () => {}) : null);

// The rest of the suite depends on git - register them only if available.
if (!SKIP) {
  test('end-to-end: same across all four classes on an unchanged worktree', () => {
    const { root, baseSha } = setupRepo();
    try {
      const html = readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8');
      const r = detectDrift(html, baseSha, { repoRoot: root });
      assert.equal(r.byStatus.same, 2);
      assert.equal(r.byStatus.moved, 0);
      assert.equal(r.byStatus.gone, 0);
      assert.equal(r.byStatus.unresolvable, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('end-to-end: moved = 1 when an insertion above shifts the cited line', () => {
    const { root, baseSha } = setupRepo();
    try {
      // Second commit: prepend a line to src/a.js so "target-on-base" moves
      // from line 2 to line 3.
      const before = readFileSync(path.join(root, 'src', 'a.js'), 'utf8');
      writeFileSync(path.join(root, 'src', 'a.js'), 'NEW-PRE\n' + before);
      execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'prepend'], { stdio: 'ignore' });
      const html = readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8');
      const r = detectDrift(html, baseSha, { repoRoot: root });
      const c1 = r.claims.find(c => c.id === 'OK');
      assert.equal(c1.status, 'moved');
      assert.equal(c1.baseLine, 2);
      assert.equal(c1.newLine, 3);
      const c2 = r.claims.find(c => c.id === 'DOC');
      assert.equal(c2.status, 'same');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('end-to-end: gone = 1 when the cited line is rewritten on purpose', () => {
    const { root, baseSha } = setupRepo();
    try {
      // Replace the content of src/a.js entirely so the base line is
      // nowhere in the new file.
      writeFileSync(path.join(root, 'src', 'a.js'), 'completely-different-now\n');
      execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'rewrite'], { stdio: 'ignore' });
      const html = readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8');
      const r = detectDrift(html, baseSha, { repoRoot: root });
      const c1 = r.claims.find(c => c.id === 'OK');
      assert.equal(c1.status, 'gone');
      assert.equal(c1.base, 'target-on-base');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('end-to-end: unresolvable = 1 when the file did not exist at base', () => {
    const { root, baseSha } = setupRepo();
    try {
      // Add a brand new file + commit + cite it.
      writeFileSync(path.join(root, 'docs', 'new.md'), 'hello\nworld\n');
      const html = readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8');
      const html2 = html.replace(
        'DOC" data-source="doc" data-evidence="README.md:2"',
        'DOC" data-source="doc" data-evidence="docs/new.md:1"',
      );
      writeFileSync(path.join(root, 'docs', 'doc.html'), html2);
      execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'new file'], { stdio: 'ignore' });
      const r = detectDrift(readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8'), baseSha, { repoRoot: root });
      const c = r.claims.find(c => c.id === 'DOC');
      assert.equal(c.status, 'unresolvable');
      assert.equal(c.evidence, 'docs/new.md:1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('end-to-end: CRLF worktree vs LF base still classifies same', () => {
    const { root, baseSha } = setupRepo();
    try {
      // After the base commit, write a CRLF version of the same content
      // WITHOUT committing it (worktree-only).
      writeFileSync(path.join(root, 'src', 'a.js'), 'alpha\r\ntarget-on-base\r\nomega\r\n');
      const html = readFileSync(path.join(root, 'docs', 'doc.html'), 'utf8');
      // We need a custom readFn that returns the CRLF worktree text because
      // git would normalise it on commit - we want the worktree-only
      // scenario the spec calls out.
      const r = detectDrift(html, baseSha, { repoRoot: root });
      const c1 = r.claims.find(c => c.id === 'OK');
      assert.equal(c1.status, 'same', 'CRLF mismatch must not raise a false alarm');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('end-to-end: --fix rewrites moved claims in place and leaves others alone', async () => {
    const { root, baseSha } = setupRepo();
    try {
      const docPath = path.join(root, 'docs', 'doc.html');
      const before = readFileSync(path.join(root, 'src', 'a.js'), 'utf8');
      writeFileSync(path.join(root, 'src', 'a.js'), 'NEW-PRE\n' + before);
      execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'prepend src'], { stdio: 'ignore' });
      const beforeFix = readFileSync(docPath, 'utf8');
      // --fix rewrites evidence for moved rows to the worktree line where
      // the base text now lives. The doc becomes consistent with the
      // worktree (line 3 has the same text as base line 2). Re-running
      // doc-drift against the same baseSha will STILL report drift,
      // because the base line 3 is unrelated - the fix's value is to
      // anchor the doc to the surviving text, not to silently flip
      // classifications.
      const logs = [];
      const code = await docDriftCli([docPath, baseSha, '--fix'], { repoRoot: root, log: (m) => logs.push(String(m)) });
      assert.equal(code, 1, 'moved = exit 1');
      assert.ok(logs.some((l) => /fix: rewrote 1 data-evidence entry/.test(l)), JSON.stringify(logs));
      const afterFix = readFileSync(docPath, 'utf8');
      assert.notEqual(afterFix, beforeFix, '--fix must change the file');
      assert.match(afterFix, /data-claim="OK"[^>]*data-evidence="src\/a\.js:3"/);
      // DOC untouched.
      assert.match(afterFix, /data-claim="DOC"[^>]*data-evidence="README.md:2"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI subprocess smoke: --json emits parseable JSON with baseSha and claim rows', () => {
    const { root, baseSha } = setupRepo();
    try {
      const docPath = path.join(root, 'docs', 'doc.html');
      const before = readFileSync(path.join(root, 'src', 'a.js'), 'utf8');
      writeFileSync(path.join(root, 'src', 'a.js'), 'NEW-PRE\n' + before);
      execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'pre'], { stdio: 'ignore' });

      // The doc-drift CLI is shipped through fleet/bin/fleet.mjs. Invoke
      // the same way the orchestrator would. fileURLToPath (not
      // .pathname) is required on Windows: the raw pathname is
      // "/C:/..." which spawnSync cannot launch.
      const fleetPath = fileURLToPath(new URL('./fleet.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [fleetPath, 'doc-drift', docPath, baseSha, '--json'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, `moved must exit 1, got ${result.status}: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.baseSha, baseSha);
      const ok = json.claims.find(c => c.id === 'OK');
      assert.equal(ok.status, 'moved');
      assert.equal(ok.newLine, 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI: a base ref that does not resolve is a usage error (exit 2, not a green run)', () => {
    const { root } = setupRepo();
    try {
      const docPath = path.join(root, 'docs', 'doc.html');
      const fleetPath = fileURLToPath(new URL('./fleet.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [fleetPath, 'doc-drift', docPath, 'not-a-real-sha'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, `bad ref must exit 2, got ${result.status}`);
      assert.match(result.stdout, /cannot resolve base ref/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI: no drift exits 0 (same + unresolvable only)', () => {
    const { root, baseSha } = setupRepo();
    try {
      const docPath = path.join(root, 'docs', 'doc.html');
      const fleetPath = fileURLToPath(new URL('./fleet.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [fleetPath, 'doc-drift', docPath, baseSha], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `clean doc must exit 0, got ${result.status}: ${result.stdout}`);
      assert.match(result.stdout, /same: 2/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
