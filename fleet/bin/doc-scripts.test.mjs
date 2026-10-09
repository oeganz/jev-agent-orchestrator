// T4-fix-clickable: per-block JS parse guard for the project-doc HTML family.
//
// The doc and the template each ship one inline <script> block (everything else
// is JSON metadata or a CDN src). On 2026-10-08 the doc shipped with
// `panes.forEach(function (x) => x.classList.remove('active'));` - a mix of
// function expression and arrow that is not valid JS. The browser aborted the
// whole inline script at parse time, so the review toggle, sidebar, and claim
// clicks never bound. The "inline script parses" check that ran during
// shipping extracted the doc-meta JSON block instead of the JS block, so the
// bug slipped through.
//
// This suite makes that class impossible to miss. For every project-doc HTML
// (template + every docs/*.html), it:
//   1. Walks every <script>...</script> in order, dropping any with src= or
//      type="application/json" (those are JSON payloads or remote libs - not
//      "inline JS" the doc author owns).
//   2. Asserts at least one inline JS block was found (vacuous-extractor
//      tripwire - a broken extractor that returns zero blocks can no longer
//      report "ok").
//   3. Compiles each remaining block with `new vm.Script(body, {filename})`
//      and asserts the SyntaxError is absent. On failure, it reports the
//      block's starting line number so the fix lands at the right place.
//
// Static-scan guard for the same shape (`function (x) => ...`):
//   4. Greps the file for `function *\(...\) *=>` and asserts no match in any
//      doc HTML, since the parser above would catch the same shape but a
//      cheap regex makes the intent obvious in CI output.
//
// Hermetic: reads only the listed local files. No network, no writes, no
// Node-side document/element. vm.Script parses, it does not execute.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const TEMPLATE = join(HERE, '..', 'templates', 'project-doc.template.html');
const DOCS_DIR = join(ROOT, 'docs');

// Project-doc HTML files: the template + every docs/*.html. The template is
// fixed; docs/*.html is the rendered output. Both must stay in sync.
function projectDocFiles() {
  const out = [TEMPLATE];
  if (existsSync(DOCS_DIR)) {
    for (const name of readdirSync(DOCS_DIR).sort()) {
      if (!name.toLowerCase().endsWith('.html')) continue;
      const abs = join(DOCS_DIR, name);
      try { if (statSync(abs).isFile()) out.push(abs); } catch (_) { /* not a file */ }
    }
  }
  return out;
}

// Extract every <script ...>...</script> with its attribute string, body, and
// the 1-based starting line of the body (the line right after the opening
// tag's `>`). Order matches document order.
function extractScriptBlocks(html) {
  const re = /<script\b([^>]*?)>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html))) {
    const fullStart = m.index;
    const openTagEnd = fullStart + m[0].indexOf('>') + 1;       // 0-based, points to first char of body
    const bodyStartLine = html.slice(0, openTagEnd).split('\n').length;
    blocks.push({ attrs: m[1], body: m[2], openTagEnd, bodyStartLine });
  }
  return blocks;
}

// Decide whether a block is JSON metadata / an external src (skip) or
// inline JS (compile).
function isJsonMeta(attrs) {
  return /\btype\s*=\s*["']application\/json["']/i.test(attrs);
}
function isExternalSrc(attrs) {
  return /\bsrc\s*=/i.test(attrs);
}

// Static-scan: any line containing `function ( <args> ) =>` is almost
// certainly the bug class we are guarding against. The vm.Script compile
// above catches it too, but a regex makes the failure unmistakable in CI
// and lets us report the exact line, not just "block at line N".
const FN_ARROW_RE = /\bfunction\s*\([^)]*\)\s*=>/;

function linesContaining(src, re) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
  }
  return hits;
}

// ---------- The actual checks ---------------------------------------------

test('every project-doc HTML exists', () => {
  const files = projectDocFiles();
  // We need at least the template. Failing here means the extractor or the
  // repo layout drifted - that itself is a guard worth keeping.
  assert.ok(files.length >= 1, `no project-doc HTML files found (template at ${TEMPLATE})`);
  for (const f of files) assert.ok(existsSync(f), `missing: ${f}`);
});

test('every project-doc HTML contains at least one inline JS block (vacuous-extractor tripwire)', () => {
  for (const f of projectDocFiles()) {
    const src = readFileSync(f, 'utf8');
    const blocks = extractScriptBlocks(src).filter(b => !isJsonMeta(b.attrs) && !isExternalSrc(b.attrs));
    assert.ok(
      blocks.length >= 1,
      `${relative(ROOT, f).split(sep).join('/')}: zero inline JS blocks found - the extractor is broken or the file dropped its script`,
    );
  }
});

test('every inline JS block in every project-doc HTML parses cleanly with node:vm', () => {
  for (const f of projectDocFiles()) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f).split(sep).join('/');
    const blocks = extractScriptBlocks(src).filter(b => !isJsonMeta(b.attrs) && !isExternalSrc(b.attrs));
    const errors = [];
    for (const b of blocks) {
      try {
        new vm.Script(b.body, { filename: `${rel}:line ${b.bodyStartLine}` });
      } catch (e) {
        errors.push(`  block starting at line ${b.bodyStartLine}: ${e?.message || e}`);
      }
    }
    assert.deepEqual(errors, [], `${rel}: ${errors.length} inline JS block(s) failed to parse\n${errors.join('\n')}`);
  }
});

test('no project-doc HTML contains the `function (x) => ...` arrow/function mismatch', () => {
  for (const f of projectDocFiles()) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f).split(sep).join('/');
    const hits = linesContaining(src, FN_ARROW_RE);
    assert.deepEqual(
      hits,
      [],
      `${rel}: found ${hits.length} line(s) with the function-expression+arrow mismatch: ` +
      hits.map(h => `line ${h.line}: ${h.text}`).join(' | '),
    );
  }
});

// Same shape as above but for the JS block only - proves the fix sticks even
// if someone wraps the bad pattern across a line break later.
test('no inline JS block contains `function (...)=>` on a single line (vm.Script + filename line range)', () => {
  for (const f of projectDocFiles()) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f).split(sep).join('/');
    const blocks = extractScriptBlocks(src).filter(b => !isJsonMeta(b.attrs) && !isExternalSrc(b.attrs));
    const hits = [];
    for (const b of blocks) {
      const lines = b.body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (FN_ARROW_RE.test(lines[i])) {
          hits.push(`  block starting at line ${b.bodyStartLine}, body line ${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    assert.deepEqual(hits, [], `${rel}: ${hits.length} offending line(s)\n${hits.join('\n')}`);
  }
});

// Synthetic tripwire: a tiny file with the broken pattern must be caught.
// Kept inline (no fixtures dir needed) so the suite stays self-contained.
test('synthetic fixture with `function (x) =>` is rejected', () => {
  const bad = 'panes.forEach(function (x) => x.classList.remove("active"));\n';
  let threw = null;
  try { new vm.Script(bad, { filename: 'synthetic.test' }); }
  catch (e) { threw = e; }
  assert.ok(threw, 'vm.Script did NOT throw on the bad pattern - vm has changed semantics, this guard is no longer valid');
  assert.match(String(threw?.message || threw), /=>/, `expected arrow-token error, got: ${threw?.message}`);
});

test('synthetic fixture with a well-formed arrow function parses cleanly', () => {
  const good = 'panes.forEach(function (x) { x.classList.remove("active"); });\n';
  // Must not throw.
  new vm.Script(good, { filename: 'synthetic-good.test' });
});