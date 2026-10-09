// T9r-restore-section6: hermetic guard for .claude/skills/fleet-orchestrator/SKILL.md.
// T9 rewrote "5c up to the next heading" while 5c sat INSIDE section 6 and
// silently deleted section 6's policy body. These tests fail if a load-bearing
// G2 anchor disappears or if the numbered "### N" / "### Nx" headings fall out
// of numeric order (the misplacement that made the deletion possible).
// Reads one local file only - no network, no writes. SKILL_DOC_PATH overrides
// the path so the guard can be pointed at an older revision (red check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = process.env.SKILL_DOC_PATH
  || fileURLToPath(new URL('../../.claude/skills/fleet-orchestrator/SKILL.md', import.meta.url));
const text = readFileSync(DOC, 'utf8');

const ANCHORS = [
  'if any noul > 0.55',
  'below auto_apply',
  'Then, ALWAYS, independently of the JEV verdict',
  'A disagreement is',
  'never auto-pass',
  'cygpath -m',
];

for (const anchor of ANCHORS) {
  test(`SKILL.md keeps the load-bearing anchor ${JSON.stringify(anchor)}`, () => {
    assert.ok(text.toLowerCase().includes(anchor.toLowerCase()),
      `anchor ${JSON.stringify(anchor)} missing from ${DOC}`);
  });
}

// "### 6. G2 ..." -> [6, ''], "### 5c. Asking ..." -> [5, 'c']; unnumbered
// headings ("### Delivery and tooling rule", "### G4 - ...") are skipped.
export function numberedHeadings(src) {
  const out = [];
  for (const m of src.matchAll(/^### (\d+)([a-z]?)\.\s/gm)) out.push({ n: Number(m[1]), s: m[2], label: `${m[1]}${m[2]}` });
  return out;
}

test('numberedHeadings parses N and Nx headings and skips unnumbered ones', () => {
  const got = numberedHeadings('### 1. A\n### Delivery\n### 5c. B\n### G4 - C\n### 10. D\n').map(h => h.label);
  assert.deepEqual(got, ['1', '5c', '10']);
});

test('SKILL.md numbered section headings are in strictly increasing numeric order', () => {
  const hs = numberedHeadings(text);
  assert.ok(hs.length >= 10, `expected the numbered sections, found ${hs.length}`);
  const bad = [];
  for (let i = 1; i < hs.length; i++) {
    const a = hs[i - 1], b = hs[i];
    if (!(b.n > a.n || (b.n === a.n && b.s > a.s))) bad.push(`${a.label} -> ${b.label}`);
  }
  assert.deepEqual(bad, [], `out-of-order headings: ${bad.join(', ')} (order: ${hs.map(h => h.label).join(' ')})`);
});

test('section 6 (G2) is contiguous: its policy body sits under its own heading', () => {
  const start = text.indexOf('### 6. G2 - build gate');
  assert.ok(start >= 0, 'section 6 heading found');
  const next = text.indexOf('\n### ', start + 1);
  const section6 = next < 0 ? text.slice(start) : text.slice(start, next);
  for (const anchor of ['signal first', 'if any noul > 0.55', 'Then, ALWAYS, independently of the JEV verdict', 'A disagreement is']) {
    assert.ok(section6.includes(anchor), `section 6 body must contain ${JSON.stringify(anchor)}`);
  }
});
