// Tests for fleet/bin/lib/project-doc.mjs - claim extraction, doc validation and
// the human-vs-AI gap report behind `fleet doc-check` / `fleet doc-gap`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractClaims, validateDoc, gapReport, formatGapReport, SOURCES } from './lib/project-doc.mjs';

const META = '<script type="application/json" id="doc-meta">{"project":"demo","doc_version":"1","generated_by":"ai","generated_at":"2026-10-08","commit":"abc123"}</script>';

const FIXTURE = `<!doctype html><html><head>${META}
<style>.claim{color:red} /* <span class="claim" data-claim="C-STYLE"> */</style>
</head><body>
<div id="page-overview" class="page-pane active">
  <p>Intro <span class="claim" data-claim="C-001" data-source="code" data-evidence="src/a.js:2">A &amp; B are <b>joined</b></span> here.<br>
  <img src="x.png"></p>
  <div class="claim note" data-claim="C-002" data-source="doc" data-evidence="README.md:1">
    Block claim with <span class="claim" data-claim="C-003" data-source="inferred">nested inferred</span> inside.
  </div>
</div>
<!-- <span class="claim" data-claim="C-COMMENT" data-source="code"></span> -->
<div id='page-arch' class='page-pane'>
  <div class="tab-pane"><ul><li>item <span class='claim' data-claim='C-004' data-source='config' data-evidence='conf/x.json:3-4'>config claim</span></ul></div>
</div>
<span class="claim" data-claim="C-005" data-source="inferred">outside any page</span>
<span class="claimish" data-claim="NOT-A-CLAIM">no</span>
<script>const s = '<span class="claim" data-claim="C-SCRIPT">';</script>
</body></html>`;

test('extractClaims finds inline, block and nested claims in document order', () => {
  const claims = extractClaims(FIXTURE);
  assert.deepEqual(claims.map(c => c.id), ['C-001', 'C-002', 'C-003', 'C-004', 'C-005']);
});

test('extractClaims ignores script, style, comments and non-claim classes', () => {
  const ids = extractClaims(FIXTURE).map(c => c.id);
  for (const bad of ['C-STYLE', 'C-COMMENT', 'C-SCRIPT', 'NOT-A-CLAIM']) assert.ok(!ids.includes(bad), bad);
});

test('extractClaims returns source, evidence, decoded text and page attribution', () => {
  const byId = Object.fromEntries(extractClaims(FIXTURE).map(c => [c.id, c]));
  assert.deepEqual(byId['C-001'], { id: 'C-001', source: 'code', evidence: 'src/a.js:2', text: 'A & B are joined', page: 'page-overview' });
  assert.equal(byId['C-002'].text, 'Block claim with nested inferred inside.');
  assert.equal(byId['C-002'].page, 'page-overview');
  assert.equal(byId['C-003'].evidence, null);
  assert.equal(byId['C-003'].page, 'page-overview');
  assert.equal(byId['C-004'].page, 'page-arch', 'unclosed <li> must not break page attribution');
  assert.equal(byId['C-004'].evidence, 'conf/x.json:3-4');
  assert.equal(byId['C-005'].page, null);
});

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'project-doc-test-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'conf'));
    writeFileSync(join(root, 'src', 'a.js'), 'line1\nline2\nline3\n');
    writeFileSync(join(root, 'README.md'), '# readme\n');
    writeFileSync(join(root, 'conf', 'x.json'), '{\n "a": 1,\n "b": 2,\n "c": 3\n}\n');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const doc = (body, meta = META) => `<html><head>${meta}</head><body><div id="page-p" class="page-pane">${body}</div></body></html>`;
const claim = (id, source, evidence) =>
  `<span class="claim" data-claim="${id}" data-source="${source}"${evidence === undefined ? '' : ` data-evidence="${evidence}"`}>t</span>`;

test('validateDoc passes a clean fixture', () => withRoot(root => {
  const r = validateDoc(FIXTURE, { root });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
}));

test('SOURCES vocabulary is code|config|doc|inferred', () => {
  assert.deepEqual([...SOURCES], ['code', 'config', 'doc', 'inferred']);
});

const cases = [
  ['duplicate ids', claim('C-1', 'code', 'src/a.js:1') + claim('C-1', 'code', 'src/a.js:2'), /duplicate claim id C-1/],
  ['source not in vocabulary', claim('C-1', 'guess', 'src/a.js:1'), /C-1: source "guess" not in/],
  ['missing source', claim('C-1', '', 'src/a.js:1'), /C-1: source "" not in/],
  ['missing evidence for non-inferred', claim('C-1', 'code'), /C-1: missing data-evidence/],
  ['evidence file not found', claim('C-1', 'code', 'src/nope.js:1'), /C-1: evidence file not found: src\/nope.js/],
  ['line beyond file length', claim('C-1', 'code', 'src/a.js:99'), /C-1: line 99 beyond end of src\/a.js \(3 lines\)/],
  ['range end beyond file length', claim('C-1', 'config', 'conf/x.json:2-40'), /C-1: line 40 beyond end of conf\/x.json/],
  ['evidence escaping root', claim('C-1', 'doc', '../outside.md:1'), /C-1: evidence escapes root/],
  ['malformed line', claim('C-1', 'code', 'src/a.js:abc'), /C-1: malformed evidence/],
  ['claim without id', '<span class="claim" data-source="inferred">x</span>', /claim without data-claim id/],
];
for (const [name, body, re] of cases) {
  test(`validateDoc reports: ${name}`, () => withRoot(root => {
    const r = validateDoc(doc(body), { root });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.errors.some(e => re.test(e)), `${re} not in ${JSON.stringify(r.errors)}`);
  }));
}

test('validateDoc reports missing doc-meta', () => withRoot(root => {
  const r = validateDoc(doc(claim('C-1', 'inferred'), ''), { root });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /doc-meta missing/.test(e)), JSON.stringify(r.errors));
}));

test('validateDoc reports invalid doc-meta JSON', () => withRoot(root => {
  const bad = '<script type="application/json" id="doc-meta">{not json</script>';
  const r = validateDoc(doc(claim('C-1', 'inferred'), bad), { root });
  assert.ok(r.errors.some(e => /doc-meta invalid JSON/.test(e)), JSON.stringify(r.errors));
}));

test('validateDoc reports doc-meta missing keys', () => withRoot(root => {
  const partial = '<script type="application/json" id="doc-meta">{"project":"demo"}</script>';
  const r = validateDoc(doc(claim('C-1', 'inferred'), partial), { root });
  assert.ok(r.errors.some(e => /doc-meta missing key: doc_version/.test(e)), JSON.stringify(r.errors));
}));

test('validateDoc warns (not errors) on a claim outside any page', () => withRoot(root => {
  const html = `<html><head>${META}</head><body>${claim('C-1', 'inferred', 'src/a.js:1')}</body></html>`;
  const r = validateDoc(html, { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some(w => /C-1: not inside a page-pane/.test(w)), JSON.stringify(r.warnings));
}));

test('validateDoc without root skips file checks with a warning', () => {
  const r = validateDoc(doc(claim('C-1', 'code', 'src/nope.js:1')));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some(w => /no root/.test(w)));
});

test('validateDoc warns when the doc has no claims', () => withRoot(root => {
  const r = validateDoc(doc('<p>nothing</p>'), { root });
  assert.ok(r.warnings.some(w => /no claims/.test(w)));
}));

// ---- T2c-evidence-quality: blank/whitespace lines, line-number sanity,
// number-in-text heuristic, and tiny-claim noise (warnings, not errors).

// src/a.js is "line1\nline2\nline3\n" (3 lines). Line 4 is beyond file end
// (already an error). Line 2 carries "line2" - so a claim of "blank" citing
// line 2 is NOT actually citing a blank line. We need a fixture that has a
// blank line; we add it inline below.

test('validateDoc errors when the cited line is blank/whitespace', () => withRoot(root => {
  const blankRoot = mkdtempSync(join(tmpdir(), 'project-doc-blank-'));
  try {
    mkdirSync(join(blankRoot, 'src'));
    writeFileSync(join(blankRoot, 'src', 'p.js'), 'line1\n\nline3\n');
    const r = validateDoc(doc(claim('C-BL', 'code', 'src/p.js:2')), { root: blankRoot });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.errors.some(e => /C-BL.*cited line.*blank|whitespace/i.test(e)), JSON.stringify(r.errors));
  } finally { rmSync(blankRoot, { recursive: true, force: true }); }
}));

test('validateDoc errors when line number is zero', () => withRoot(root => {
  const r = validateDoc(doc(claim('C-Z', 'code', 'src/a.js:0')), { root });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.errors.some(e => /C-Z.*line number.*must be >= 1/i.test(e)), JSON.stringify(r.errors));
}));

test('validateDoc errors when line number is negative', () => withRoot(root => {
  const r = validateDoc(doc(claim('C-N', 'code', 'src/a.js:-1')), { root });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.errors.some(e => /C-N.*line number.*must be >= 1/i.test(e)), JSON.stringify(r.errors));
}));

test('validateDoc warns when a code claim contains a number not in the cited line or +/-15', () => withRoot(root => {
  const numRoot = mkdtempSync(join(tmpdir(), 'project-doc-num-'));
  try {
    mkdirSync(join(numRoot, 'src'));
    // The line cited by the claim is the import line - contains no "9".
    // The +/-15 region (a 15-line slice) must also not contain "9", so use
    // letters only (no digits anywhere in the file).
    const body = ['import test from \'node:test\';']; // line 1
    for (let i = 2; i <= 16; i++) body.push(`// helper alpha bravo charlie`); // 15 more lines, no digits
    writeFileSync(join(numRoot, 'src', 'count.test.mjs'), body.join('\n') + '\n');
    const html = doc(`<span class="claim" data-claim="C-NUM" data-source="code" data-evidence="src/count.test.mjs:1">9 tests</span>`);
    const r = validateDoc(html, { root: numRoot });
    assert.equal(r.ok, true, JSON.stringify(r));
    const w = r.warnings.find(w => /C-NUM/.test(w));
    assert.ok(w, JSON.stringify(r.warnings));
    assert.match(w, /number "9"/);
  } finally { rmSync(numRoot, { recursive: true, force: true }); }
}));

test('validateDoc does NOT warn when the number appears in the cited line', () => withRoot(root => {
  const r = validateDoc(doc(claim('C-OK', 'code', 'src/a.js:2')), { root });
  // claim text "t" is too short, so we can't use the existing helper - build one inline
  const html2 = doc(`<span class="claim" data-claim="C-OK" data-source="code" data-evidence="src/a.js:2">2nd line</span>`);
  const r2 = validateDoc(html2, { root });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(!r2.warnings.some(w => /C-OK.*number/.test(w)), JSON.stringify(r2.warnings));
}));

test('validateDoc does NOT warn when the number appears in the +/-15 region', () => withRoot(root => {
  const regRoot = mkdtempSync(join(tmpdir(), 'project-doc-reg-'));
  try {
    mkdirSync(join(regRoot, 'src'));
    // line 1 has the import, lines 2-16 mention "9"
    const lines = ['import x;'];
    for (let i = 2; i <= 16; i++) lines.push(`// helper ${i} - 9 in line ${i}`);
    writeFileSync(join(regRoot, 'src', 'r.js'), lines.join('\n') + '\n');
    const html = doc(`<span class="claim" data-claim="C-NEAR" data-source="code" data-evidence="src/r.js:1">9 something</span>`);
    const r = validateDoc(html, { root: regRoot });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!r.warnings.some(w => /C-NEAR.*number/.test(w)), JSON.stringify(r.warnings));
  } finally { rmSync(regRoot, { recursive: true, force: true }); }
}));

test('validateDoc warns when claim text is shorter than 3 characters', () => withRoot(root => {
  const r = validateDoc(doc(`<span class="claim" data-claim="C-TINY" data-source="doc" data-evidence="README.md:1">ab</span>`), { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.warnings.some(w => /C-TINY.*shorter than 3/.test(w)), JSON.stringify(r.warnings));
}));

test('validateDoc does NOT warn for short text on an inferred claim', () => withRoot(root => {
  const r = validateDoc(doc(`<span class="claim" data-claim="C-I" data-source="inferred">ab</span>`), { root });
  // text-length warning is suppressed for inferred claims; they have no evidence
  assert.ok(!r.warnings.some(w => /C-I.*shorter than 3/.test(w)), JSON.stringify(r.warnings));
}));

// ---- T1-anchor-citations: anchor-form evidence (path#substring) ------------
//
// The anchor form lets a doc author cite a stable text snippet rather than a
// line number, so adding lines to a file doesn't silently shift citations.
// The validator must:
//   - accept `path#anchor` when the anchor is found verbatim in the file
//   - reject when the anchor is missing, empty, or whitespace-only
//   - reject the same escape/absolute-path conditions as the line form
//   - normalise CRLF to LF so a Windows-checkout worktree matches an LF anchor
//   - skip the blank-line and number-in-text heuristics (anchors are not
//     positional)
//   - never change behaviour for the existing path:line form

function withAnchorRoot(fn, extras = {}) {
  const root = mkdtempSync(join(tmpdir(), 'project-doc-anchor-'));
  try {
    mkdirSync(join(root, 'src'));
    if (extras.crlf) {
      // CRLF payload - simulates core.autocrlf=true checkout.
      writeFileSync(join(root, 'src', 'crlf.js'), 'function settle() {\r\n  return "release every reclaimable worker";\r\n}\r\n');
    }
    writeFileSync(join(root, 'src', 'a.js'), 'line1\nline2\nline3\n');
    writeFileSync(join(root, 'src', 'shell.js'), '#!/bin/sh\necho "hello $world"|grep "y"\nif [ `uname` = "Linux" ]; then :; fi\n');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('validateDoc accepts an anchor citation when the anchor is found', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN1" data-source="code" data-evidence="src/a.js#line2">anchor cite of line2</span>`),
    { root },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.errors, []);
}));

test('validateDoc errors when the anchor does not occur in the file', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN2" data-source="code" data-evidence="src/a.js#not-here">x</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-AN2.*evidence anchor not found in src\/a\.js.*"not-here"/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc accepts anchors containing quotes, $, |, backticks and semicolons', () => withAnchorRoot(root => {
  // Pick an anchor that lives verbatim in shell.js - the literal text on the
  // second line of that fixture file. The HTML attribute uses single quotes
  // for the outer wrapper, so the inner double quotes need no escaping.
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN3" data-source="code" data-evidence='src/shell.js#echo "hello $world"|grep "y"'>anchor with shell chars</span>`),
    { root },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.errors, []);
}));

test('validateDoc accepts an anchor that matches across a CRLF/LF boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-doc-anchor-crlf-'));
  try {
    mkdirSync(join(root, 'src'));
    // CRLF payload - simulates core.autocrlf=true checkout.
    writeFileSync(join(root, 'src', 'crlf.js'), 'function settle() {\r\n  return "release every reclaimable worker";\r\n}\r\n');
    const r = validateDoc(
      doc(`<span class="claim" data-claim="C-AN4" data-source="code" data-evidence="src/crlf.js#function settle() {">anchor across CRLF</span>`),
      { root },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.errors, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('validateDoc errors when the anchor is empty', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN5" data-source="code" data-evidence="src/a.js#">x</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-AN5.*evidence anchor is empty or whitespace-only/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc errors when the anchor is whitespace-only', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN6" data-source="code" data-evidence="src/a.js#   \t  ">x</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-AN6.*evidence anchor is empty or whitespace-only/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc errors when the anchor file does not exist', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-AN7" data-source="code" data-evidence="src/missing.js#anything">x</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-AN7.*evidence file not found: src\/missing\.js/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc still validates the existing path:line form identically', () => withAnchorRoot(root => {
  // Regression: the line form must not pick up anchor behaviour. A blank
  // line cite should still error; a valid line cite should still pass.
  const blankCite = doc(`<span class="claim" data-claim="C-AN8" data-source="code" data-evidence="src/a.js:2">line2</span>`);
  const r1 = validateDoc(blankCite, { root });
  assert.equal(r1.ok, true, JSON.stringify(r1));

  // Build a file that contains a truly blank line so the existing blank-line
  // check has something to flag.
  const blankRoot = mkdtempSync(join(tmpdir(), 'project-doc-anchor-blank-'));
  try {
    mkdirSync(join(blankRoot, 'src'));
    writeFileSync(join(blankRoot, 'src', 'p.js'), 'line1\n\nline3\n');
    const r2 = validateDoc(
      doc(`<span class="claim" data-claim="C-AN8B" data-source="code" data-evidence="src/p.js:2">x</span>`),
      { root: blankRoot },
    );
    assert.equal(r2.ok, false, JSON.stringify(r2));
    assert.ok(
      r2.errors.some(e => /C-AN8B.*cited line.*blank|whitespace/i.test(e)),
      JSON.stringify(r2.errors),
    );
  } finally { rmSync(blankRoot, { recursive: true, force: true }); }
}));

test('validateDoc accepts a mixed doc that uses both evidence forms', () => withAnchorRoot(root => {
  const html = doc(
    `<span class="claim" data-claim="C-MIX1" data-source="code" data-evidence="src/a.js:2">line cite</span>` +
    `<span class="claim" data-claim="C-MIX2" data-source="code" data-evidence="src/a.js#line2">anchor cite</span>`,
  );
  const r = validateDoc(html, { root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.errors, []);
}));

test('validateDoc errors when a non-inferred claim has neither path:line nor anchor', () => withAnchorRoot(root => {
  // No data-evidence at all - the existing missing-evidence path must still
  // fire regardless of the new anchor form.
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-NO" data-source="code">no evidence</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-NO.*missing data-evidence/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc passes when an anchor substring appears multiple times in the file', () => withAnchorRoot(root => {
  // "line2" appears once in src/a.js (line2), but a 3-line file with the
  // same substring repeated is a common real case (a function called
  // multiple times). Anchors are not positional: any occurrence counts.
  const multiRoot = mkdtempSync(join(tmpdir(), 'project-doc-anchor-multi-'));
  try {
    mkdirSync(join(multiRoot, 'src'));
    writeFileSync(join(multiRoot, 'src', 'm.js'), 'doFoo();\ndoFoo();\ndoFoo();\n');
    const r = validateDoc(
      doc(`<span class="claim" data-claim="C-MULTI" data-source="code" data-evidence="src/m.js#doFoo();">x</span>`),
      { root: multiRoot },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.errors, []);
  } finally { rmSync(multiRoot, { recursive: true, force: true }); }
}));

test('validateDoc errors when an anchor citation escapes the root', () => withAnchorRoot(root => {
  const r = validateDoc(
    doc(`<span class="claim" data-claim="C-ESC" data-source="doc" data-evidence="../outside.md#anything">x</span>`),
    { root },
  );
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(
    r.errors.some(e => /C-ESC.*evidence escapes root/.test(e)),
    JSON.stringify(r.errors),
  );
}));

test('validateDoc skips the blank-line / number-in-text heuristics for anchors', () => {
  // Build a file that contains a real token plus a blank line - a `path:N`
  // cite on the blank line would fire the blank-line check. The same file
  // cited via an anchor pointing at the real token must pass, since anchors
  // have no positional blank-line or number-in-text check.
  const blankRoot = mkdtempSync(join(tmpdir(), 'project-doc-anchor-blankonly-'));
  try {
    mkdirSync(join(blankRoot, 'src'));
    writeFileSync(join(blankRoot, 'src', 'q.js'), 'real-token\n   \n');
    const r = validateDoc(
      doc(`<span class="claim" data-claim="C-SKIP" data-source="code" data-evidence="src/q.js#real-token">anchor in token file</span>`),
      { root: blankRoot },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.errors, []);
  } finally { rmSync(blankRoot, { recursive: true, force: true }); }
});

test('validateDoc distinguishes the anchor error from the blank-line error', () => withAnchorRoot(root => {
  // Two claims in one doc: one cites a blank line (line form -> blank-line
  // error), the other cites a missing anchor (anchor form -> anchor-not-found
  // error). Both must be errors, and the messages must not be confusable.
  const blankRoot = mkdtempSync(join(tmpdir(), 'project-doc-anchor-distinguish-'));
  try {
    mkdirSync(join(blankRoot, 'src'));
    writeFileSync(join(blankRoot, 'src', 'd.js'), 'line1\n\nline3\n');
    const html = doc(
      `<span class="claim" data-claim="C-D1" data-source="code" data-evidence="src/d.js:2">blank line</span>` +
      `<span class="claim" data-claim="C-D2" data-source="code" data-evidence="src/d.js#missing-piece">anchor miss</span>`,
    );
    const r = validateDoc(html, { root: blankRoot });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(
      r.errors.some(e => /C-D1.*cited line.*blank|whitespace/i.test(e)),
      JSON.stringify(r.errors),
    );
    assert.ok(
      r.errors.some(e => /C-D2.*evidence anchor not found.*"missing-piece"/.test(e)),
      JSON.stringify(r.errors),
    );
    // The two messages must be distinguishable: one says "blank", the other says "anchor".
    const d1 = r.errors.find(e => /C-D1/.test(e));
    const d2 = r.errors.find(e => /C-D2/.test(e));
    assert.ok(d1 && !/anchor/.test(d1), `C-D1 msg should not mention "anchor": ${d1}`);
    assert.ok(d2 && /anchor/.test(d2) && !/blank/.test(d2), `C-D2 msg should mention "anchor" not "blank": ${d2}`);
  } finally { rmSync(blankRoot, { recursive: true, force: true }); }
}));

const CLAIMS = [
  { id: 'C-1', source: 'code', evidence: 'a:1', text: 'one', page: 'page-a' },
  { id: 'C-2', source: 'code', evidence: 'a:2', text: 'two', page: 'page-a' },
  { id: 'C-3', source: 'inferred', evidence: null, text: 'three', page: 'page-b' },
  { id: 'C-4', source: 'config', evidence: 'c:1', text: 'four', page: 'page-b' },
  { id: 'C-5', source: 'inferred', evidence: null, text: 'five', page: 'page-b' },
];
const REVIEW = {
  project: 'demo', doc_version: '1', reviewer: 'rh', reviewed_at: '2026-10-08T00:00:00Z',
  reviews: [
    { id: 'C-1', verdict: 'agree', note: '' },
    { id: 'C-2', verdict: 'wrong', note: 'it is line 3' },
    { id: 'C-3', verdict: 'wrong', note: 'not true' },
    { id: 'C-4', verdict: 'unsure', note: 'check' },
    { id: 'C-99', verdict: 'agree', note: 'stale' },
  ],
};

test('gapReport counts coverage and verdicts', () => {
  const g = gapReport(CLAIMS, REVIEW);
  assert.equal(g.total, 5);
  assert.equal(g.reviewed, 4);
  assert.equal(g.coverage, 0.8);
  assert.deepEqual(g.byVerdict, { agree: 1, wrong: 2, unsure: 1, unreviewed: 1 });
  assert.deepEqual(g.bySourceVerdict.code, { agree: 1, wrong: 1, unsure: 0, unreviewed: 0 });
  assert.deepEqual(g.bySourceVerdict.inferred, { agree: 0, wrong: 1, unsure: 0, unreviewed: 1 });
  assert.deepEqual(g.bySourceVerdict.config, { agree: 0, wrong: 0, unsure: 1, unreviewed: 0 });
  assert.deepEqual(g.bySourceVerdict.doc, { agree: 0, wrong: 0, unsure: 0, unreviewed: 0 });
});

test('gapReport lists wrong, unsure, inferredWrong with notes, and unknownIds', () => {
  const g = gapReport(CLAIMS, REVIEW);
  assert.deepEqual(g.wrong.map(w => w.id), ['C-2', 'C-3']);
  assert.equal(g.wrong[0].note, 'it is line 3');
  assert.equal(g.wrong[0].text, 'two');
  assert.deepEqual(g.unsure.map(w => w.id), ['C-4']);
  assert.deepEqual(g.inferredWrong.map(w => w.id), ['C-3']);
  assert.deepEqual(g.unknownIds, ['C-99']);
});

test('gapReport: later review rows win, invalid verdicts count as unreviewed', () => {
  const g = gapReport(CLAIMS, { reviews: [
    { id: 'C-1', verdict: 'wrong' }, { id: 'C-1', verdict: 'agree' }, { id: 'C-2', verdict: 'maybe' },
  ] });
  assert.equal(g.reviewed, 1);
  assert.equal(g.byVerdict.agree, 1);
  assert.equal(g.byVerdict.wrong, 0);
  assert.deepEqual(g.invalid, [{ id: 'C-2', verdict: 'maybe' }]);
});

test('gapReport on empty doc and empty review has zero coverage, not NaN', () => {
  const g = gapReport([], { reviews: [] });
  assert.equal(g.total, 0);
  assert.equal(g.coverage, 0);
});

test('gapReport accepts a bare reviews array', () => {
  const g = gapReport(CLAIMS, [{ id: 'C-1', verdict: 'agree' }]);
  assert.equal(g.reviewed, 1);
});

test('formatGapReport renders markdown with headline numbers and sections', () => {
  const md = formatGapReport(gapReport(CLAIMS, REVIEW));
  assert.match(md, /^# Gap report/m);
  assert.match(md, /demo/);
  assert.match(md, /Coverage: 4\/5 \(80%\)/);
  assert.match(md, /## Wrong \(2\)/);
  assert.match(md, /C-2.*it is line 3/);
  assert.match(md, /## Inferred and wrong \(1\)/);
  assert.match(md, /## Unknown ids \(1\)/);
  assert.match(md, /\| inferred \| 0 \| 1 \| 0 \| 1 \|/);
});