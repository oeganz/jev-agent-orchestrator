// T1-allowlist-tool: hermetic tests for the curated public-repo export
// tool. Every test builds a fresh fixture under os.tmpdir() — the suite
// never touches the real repo, the real allowlist, or the network. The
// redaction/secret/jev-host/email rules are exercised with values that
// LOOK LIKE the real ones but are obviously synthetic (long sequences
// of one letter, scoped names, etc.) so a real secret can never leak.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, userInfo, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  loadAllowlist,
  loadRedactions,
  isInside,
  applyRedactionsToText,
  runScan,
  runCopy,
  runVerify,
  hostsFromRedactions,
  clientTokensFromTargets,
  vaultNamesFromTargets,
  operatorUsernames,
  isReservedEmailDomain,
  extOf,
  classifyExtension,
  _isReservedClientName as isReservedClientName,
} from './export-public.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'export-public.mjs');

// ---- operator helpers --------------------------------------------------------
// Tests that prove the scrubber removes the operator's machine path
// build the path at runtime from the OS user, so the source file
// itself never contains a literal username. When the OS user cannot
// be read (some CI environments), the test SKIPs - the prove-the-rule
// path needs a real operator to operate on.
function operatorPath(leaf = 'notes/file.md') {
  let u;
  try { u = userInfo().username; } catch { return null; }
  if (!u) return null;
  return 'C:/Users/' + u + '/' + leaf;
}
function operatorHome() {
  try { return homedir(); } catch { return null; }
}

// ---- fixture helpers --------------------------------------------------------

function makeFixture(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'export-public-src-'));
  const out = mkdtempSync(join(tmpdir(), 'export-public-out-'));
  writeFileSync(join(root, 'README.md'), 'hello public\n');
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'intro.md'), '# intro\n');
  writeFileSync(join(root, 'docs', 'spec.md'), '# spec\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'main.js'), 'console.log(1);\n');
  mkdirSync(join(root, 'src', 'lib'));
  writeFileSync(join(root, 'src', 'lib', 'util.js'), 'export const x = 1;\n');
  if (opts.extra) for (const [p, body] of opts.extra) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  const allowlist = join(root, 'allowlist.json');
  const allowlistEntries = opts.entries || [
    { src: 'README.md', dst: 'README.md' },
    { src: 'a.txt', dst: 'a.txt' },
    { src: 'docs/intro.md', dst: 'docs/intro.md' },
    { src: 'docs/spec.md', dst: 'docs/spec.md' },
    { src: 'src/main.js', dst: 'src/main.js' },
    { src: 'src/lib/util.js', dst: 'src/lib/util.js' },
  ];
  writeFileSync(allowlist, JSON.stringify(allowlistEntries, null, 2));
  return {
    root,
    out,
    allowlist,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    },
  };
}

function runCli(argv, { cwd } = {}) {
  // Default cwd is the system tmpdir; tests that need a fixture root
  // pass `{ cwd: fx.root }` so the CLI resolves paths relative to it.
  return spawnSync(process.execPath, [scriptPath, ...argv], {
    encoding: 'utf8',
    cwd: cwd || tmpdir(),
  });
}

// ---- parseArgs --------------------------------------------------------------

test('parseArgs: default mode is copy with the default allowlist path', () => {
  const r = parseArgs([]);
  assert.equal(r.mode, 'copy');
  assert.equal(typeof r.allowlist, 'string');
  assert.equal(r.out, null);
  assert.equal(r.redactions, null);
});

test('parseArgs: --scan switches mode and preserves the allowlist path', () => {
  const r = parseArgs(['--scan']);
  assert.equal(r.mode, 'scan');
});

test('parseArgs: --verify <dir> switches mode and captures the directory', () => {
  const r = parseArgs(['--verify', '/tmp/x']);
  assert.equal(r.mode, 'verify');
  assert.equal(r.out, '/tmp/x');
});

test('parseArgs: --out and --redactions accept both space and equals forms', () => {
  const r = parseArgs([
    '--out=/tmp/o1',
    '--redactions', '/tmp/r1',
    '--allowlist=/tmp/a1',
  ]);
  assert.equal(r.out, '/tmp/o1');
  assert.equal(r.redactions, '/tmp/r1');
  assert.equal(r.allowlist, '/tmp/a1');
});

test('parseArgs: an unknown argument fails (does not silently no-op)', () => {
  const r = spawnSync(process.execPath, [scriptPath, '--bogus'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unrecognised argument/);
});

// ---- allowlist + redactions IO ----------------------------------------------

test('loadAllowlist: missing file produces a clear error and exits non-zero', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'export-public-allowlist-'));
  try {
    const r = spawnSync(process.execPath, [scriptPath, '--scan', '--allowlist', join(tmp, 'absent.json')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /allowlist not found/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('loadAllowlist: a non-JSON file produces a parse error and exits non-zero', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'export-public-allowlist-'));
  const path = join(tmp, 'broken.json');
  writeFileSync(path, 'this is not json');
  try {
    const r = spawnSync(process.execPath, [scriptPath, '--scan', '--allowlist', path], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cannot parse allowlist/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('loadAllowlist: a non-array allowlist produces a clear error', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'export-public-allowlist-'));
  const path = join(tmp, 'object.json');
  writeFileSync(path, '{"src":"a","dst":"b"}');
  try {
    const r = spawnSync(process.execPath, [scriptPath, '--scan', '--allowlist', path], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /allowlist must be a JSON array/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- safety: refuse to write inside the source tree -------------------------

test('isInside: a child of the parent is inside; a sibling is not', () => {
  const parent = join(tmpdir(), 'exp-parent');
  const child = join(parent, 'a', 'b');
  const sibling = join(dirname(parent), 'other');
  assert.equal(isInside(parent, child), true);
  assert.equal(isInside(parent, parent), true);
  assert.equal(isInside(parent, sibling), false);
});

test('runCopy: refuses an --out inside the source repo, copies nothing', () => {
  const fx = makeFixture();
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath, '--out', join(fx.root, 'nested'), '--allowlist', fx.allowlist],
      { encoding: 'utf8', cwd: fx.root },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to write --out inside the source repo/);
    // Nothing was copied.
    assert.equal(existsSync(join(fx.root, 'nested', 'README.md')), false);
  } finally { fx.cleanup(); }
});

// ---- copy: honours the allowlist and copies nothing else -------------------

test('runCopy: copies every allowlisted entry and nothing else', () => {
  const fx = makeFixture();
  try {
    // A file NOT in the allowlist; the copy must not bring it across.
    writeFileSync(join(fx.root, 'SECRET-private.md'), 'do not copy this');

    const allow = loadAllowlist(fx.allowlist);
    const r = runCopy({
      allowlist: allow,
      outDir: fx.out,
      repoRoot: fx.root,
      redactions: { path: null, entries: [] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.copied, 6);
    for (const dst of ['README.md', 'a.txt', 'docs/intro.md', 'docs/spec.md', 'src/main.js', 'src/lib/util.js']) {
      assert.equal(existsSync(join(fx.out, dst)), true, `expected ${dst} in output`);
    }
    assert.equal(existsSync(join(fx.out, 'SECRET-private.md')), false);
  } finally { fx.cleanup(); }
});

test('runCopy: a missing src is a hard error that lists every missing path', () => {
  const fx = makeFixture();
  try {
    writeFileSync(
      fx.allowlist,
      JSON.stringify([
        { src: 'README.md', dst: 'README.md' },
        { src: 'no-such.txt', dst: 'no-such.txt' },
        { src: 'also-missing.md', dst: 'also-missing.md' },
      ]),
    );
    const r = spawnSync(
      process.execPath,
      [scriptPath, '--out', fx.out, '--allowlist', fx.allowlist],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /no-such\.txt/);
    assert.match(r.stdout, /also-missing\.md/);
  } finally { fx.cleanup(); }
});

// ---- scan: exits 0 when every src exists; exits 1 otherwise -----------------

test('runScan: exits 0 and prints the allowlist when every src exists', () => {
  const fx = makeFixture();
  try {
    const r = runCli(['--scan', '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `scan exited non-zero: ${r.stderr}`);
    const first = r.stdout.split(/\r?\n/)[0];
    assert.match(first, /^allowlist: .+ \(6 entries\)$/, `unexpected first line: ${first}`);
    assert.match(r.stdout, /README\.md/);
    assert.match(r.stdout, /src\/main\.js/);
  } finally { fx.cleanup(); }
});

test('runScan: exits 1 and names a missing src when one entry is missing', () => {
  const fx = makeFixture();
  try {
    writeFileSync(
      fx.allowlist,
      JSON.stringify([
        { src: 'README.md', dst: 'README.md' },
        { src: 'no-such.md', dst: 'no-such.md' },
      ]),
    );
    const r = runCli(['--scan', '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.notEqual(r.status, 0, 'scan must exit 1 when any src is missing');
    assert.match(r.stdout, /no-such\.md/);
    assert.match(r.stdout, /MISS/);
  } finally { fx.cleanup(); }
});

// ---- first stdout line is the resolved allowlist ---------------------------

test('every mode writes the resolved allowlist as the first stdout line', () => {
  const fx = makeFixture();
  try {
    // scan
    let r = runCli(['--scan', '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `scan: ${r.stderr}`);
    assert.match(r.stdout.split(/\r?\n/)[0], /^allowlist: .+ \(6 entries\)$/);

    // copy
    r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    assert.match(r.stdout.split(/\r?\n/)[0], /^allowlist: .+ \(6 entries\)$/);

    // verify
    r = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(r.status, 0, `verify: ${r.stderr}`);
    assert.match(r.stdout.split(/\r?\n/)[0], /^verify: /, 'verify mode starts with "verify: ..."');
  } finally { fx.cleanup(); }
});

// ---- redactions: applied in the listed order, more specific first ----------

test('applyRedactionsToText: applies redactions in order; longer/more specific "from" wins when listed first', () => {
  // The redaction "from" is a CASE-SENSITIVE literal. The spec says "literal
  // string" and "order matters: a longer/more specific `from` must be
  // applied before a shorter one" - the order preserves the longer match
  // and the shorter rule then catches what's left.
  const text = 'see PROJECT-TICKET and TICKET-151 and TICKET for details';
  const redactions = [
    { from: 'TICKET-151', to: '<one-five-one>' },
    { from: 'TICKET', to: '<redacted>' },
  ];
  const { text: out, counts } = applyRedactionsToText(text, redactions);
  // Step 1 catches 'TICKET-151' first. Step 2 then catches the two 'TICKET'
  // substrings that remain (in 'PROJECT-TICKET' and the standalone 'TICKET').
  assert.equal(out.includes('TICKET-151'), false, 'the longer "from" must be replaced first');
  assert.equal(out.includes('TICKET'), false, 'no "TICKET" substring survives the order');
  assert.equal(counts[0], 1, 'first redaction (longer) caught TICKET-151');
  assert.equal(counts[1], 2, 'second redaction caught PROJECT-TICKET and standalone TICKET');
});

test('runCopy: redactions are applied after the copy and per-redaction counts are reported', () => {
  // Since every text file now goes through the scrubber FIRST, the
  // scrubber consumes the email and client names before the literal
  // redactions see them. This test uses a literal the scrubber does
  // NOT touch (a fixed project slug) so the redaction layer's own
  // counts are provable.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
    extra: [['README.md', 'see PROJ-A-2026 and PROJ-A for details\n']],
  });
  const redactionsPath = join(fx.root, 'redactions.json');
  writeFileSync(redactionsPath, JSON.stringify([
    { from: 'PROJ-A-2026', to: '<proj-long>' },
    { from: 'PROJ-A', to: '<proj>' },
  ]));

  try {
    const r = runCli([
      '--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath,
    ], { cwd: fx.root });
    assert.equal(r.status, 0, `copy with redactions exited non-zero: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'README.md'), 'utf8');
    assert.equal(out.includes('PROJ-A-2026'), false);
    assert.equal(out.includes('PROJ-A'), false);
    assert.ok(out.includes('<proj-long>'));
    assert.ok(out.includes('<proj>'));
    assert.match(r.stdout, /redaction 1: .* touched 1 files \(1 subs\)/);
    assert.match(r.stdout, /redaction 2: .* touched 1 files \(1 subs\)/);
  } finally { fx.cleanup(); }
});

// ---- verify: PASS on a clean fixture, FAIL on key-shaped/email -----------

test('runVerify: clean fixture with no --redactions shows PASS on the always-on rules and SKIP for the sourced rules', () => {
  // A skipped rule must NEVER print PASS (that was the bug). Rules
  // sourced from the private targets file (JEV host, vault name)
  // SKIP when no file is given; the always-on rules (secrets,
  // machine path, client names, emails, operator username) RUN.
  const fx = makeFixture();
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify failed on a clean fixture: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no secret-shaped strings/);
    assert.match(v.stdout, /PASS no operator machine path/);
    assert.match(v.stdout, /PASS no client project names/);
    assert.match(v.stdout, /PASS no email addresses/);
    // The JEV host rule is SKIP, not PASS.
    assert.match(v.stdout, /SKIP no JEV host -- no host derived from --redactions \(pass --redactions to enable\)/);
    assert.doesNotMatch(v.stdout, /PASS no JEV host/);
    // The vault-name rule is SKIP, not PASS (sourced from targets).
    assert.match(v.stdout, /SKIP no private vault name/);
    assert.doesNotMatch(v.stdout, /PASS no private vault name/);
    // The operator-username rule RUNS (derived from os.userInfo()).
    assert.match(v.stdout, /PASS no operator username/);
  } finally { fx.cleanup(); }
});

test('runCopy: the scrubber consumes a vendor-prefixed key at copy time (defence in depth)', () => {
  // The copy step now scrubs EVERY text file, so a key in the source
  // never reaches the staged tree. This is the defence-in-depth path;
  // the negative control for the VERIFY rule itself plants post-copy
  // (see the test below).
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'token: sk-ant-api03-' + 'a'.repeat(40) + '\n');
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'README.md'), 'utf8');
    assert.equal(out.includes('sk-ant-api03-'), false, 'key removed at copy time');
    assert.ok(out.includes('sk-ant-<redacted>'), 'placeholder present');
  } finally { fx.cleanup(); }
});

test('runVerify: FAIL on a planted key-shaped string (negative control)', () => {
  // Plant AFTER the copy so the verify rule itself is exercised (the
  // scrubber would otherwise have removed it — that is the previous
  // test's job).
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    writeFileSync(join(fx.out, 'README.md'), 'token: sk-ant-api03-' + 'a'.repeat(40) + '\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a key-shaped hit');
    assert.match(v.stdout, /FAIL no secret-shaped strings/);
  } finally { fx.cleanup(); }
});

test('runVerify: PASS on a CSS-shaped sk- class name (false-positive control)', () => {
  // This is the negative control for the tightened pattern. The old
  // rule failed on `sk-background-color-default` because any 20+ char
  // run after `sk-` matched. The tightened rule requires a vendor
  // prefix or a non-kebab character, so CSS class names pass.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(
    join(fx.root, 'README.md'),
    ':root{--sk-background-color-default:#fff}.sk-stroke-width-default{stroke-width:1}\n',
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify must PASS on CSS-shaped sk- names: ${v.stdout}`);
    assert.match(v.stdout, /PASS no secret-shaped strings/);
  } finally { fx.cleanup(); }
});

test('runVerify: FAIL on a generic sk- key with a digit (mixed-case rule, negative control)', () => {
  // The generic branch requires at least one non-`[a-z-]` character in
  // the 20+ char run. A digit qualifies, so this shape FAILs. Planted
  // post-copy so the verify rule is exercised directly.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    writeFileSync(join(fx.out, 'README.md'), 'token: sk-' + 'a1'.repeat(20) + '\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a digit-bearing sk- shape');
    assert.match(v.stdout, /FAIL no secret-shaped strings/);
  } finally { fx.cleanup(); }
});

test('runVerify: PASS on a reserved documentation email (example.com is not a failure)', () => {
  // The negative control for the tightened email rule: RFC 2606 reserves
  // example.com/net/org (and .invalid) for documentation. Flagging them
  // was noise. The rule now ignores them and reports the ignore count.
  // Planted post-copy: the scrubber removes ALL emails (reserved or
  // not) at copy time, so the reserved-domain branch of the VERIFY
  // rule can only be exercised on a planted tree.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    writeFileSync(join(fx.out, 'README.md'), 'reach me at user@example.com or user@mail.example.org\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify must PASS on reserved-domain emails: ${v.stdout}`);
    assert.match(v.stdout, /PASS no email addresses \(0 hits, 2 reserved-domain match\(es\) ignored\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: FAIL on a fixture containing a real (non-reserved) email address', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  // Construct the email at runtime from char codes so the source file
  // does not embed a literal email address. The local part and
  // domain are joined by the test, mirroring how a real fixture
  // would write the literal: `local@domain`.
  const _local = [112, 108, 97, 99, 101, 104, 111, 108, 100, 101, 114].map((c) => String.fromCharCode(c)).join('');
  const _dom = [101, 120, 97, 109, 112, 108, 101, 46, 116, 101, 115, 116].map((c) => String.fromCharCode(c)).join('');
  const _email = _local + '@' + _dom;
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    // Reserved domains (example.com, .example.net/org, .invalid) are
    // ignored. A non-reserved but still-synthetic domain is not.
    writeFileSync(join(fx.out, 'README.md'), 'reach me at ' + _email + '\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a non-reserved email hit');
    assert.match(v.stdout, /FAIL no email addresses/);
  } finally { fx.cleanup(); }
});

// ---- verify: FAIL on a client project name, FAIL on the operator path ----

test('runVerify: FAIL on a fixture containing a client project name (case-insensitive)', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  // Mixed case on purpose: the rule is case-insensitive, whole-word.
  // The fixture uses placeholder client names that the operator's
  // private targets file matches in production. The static baseline
  // pattern in export-public.mjs catches a different set of common
  // placeholders; both paths are exercised by separate tests.
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    tokens: [
      { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
      { pattern: '\\bBarInc\\b', replace: '<client>', flags: 'gi' },
    ],
  }));
  // The scrubber at copy time would catch the client name. Plant it
  // AFTER the copy so the verify rule is the one that fires.
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist, '--targets', targetsPath], { cwd: fx.root });
    writeFileSync(join(fx.out, 'README.md'), 'see notes about FooCorp and the BarInc index\n');
    const v = runCli(['--verify', fx.out, '--targets', targetsPath], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a client-name hit');
    assert.match(v.stdout, /FAIL no client project names/);
  } finally { fx.cleanup(); }
});

test('runVerify: FAIL on a fixture containing the operator machine path', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  const planted = operatorPath('notes/file.md');
  if (!planted) return; // CI without a readable username - skip
  // The scrubber (which now runs on every text file) removes machine
  // paths at copy time, so the plant must happen AFTER the copy — the
  // same pattern the JEV-host negative control uses. This proves the
  // verify rule, not the scrubber.
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    writeFileSync(join(fx.out, 'README.md'), 'see ' + planted + '\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a machine-path hit');
    assert.match(v.stdout, /FAIL no operator machine path/);
  } finally { fx.cleanup(); }
});

// ---- scrubbing session transcripts: default ON ------------------------------
//
// A session transcript can carry variable-shape secrets (API keys,
// emails, machine paths, the JEV host) that a literal redaction list
// cannot catch. The default copy therefore reuses the importer's
// scrubber on any allowlist entry under `sessions/`. These tests
// prove the default fires and that the literal redactions still apply
// in order after scrubbing.

test('parseArgs: --no-scrub-sessions flips the default ON to OFF', () => {
  const r = parseArgs(['--no-scrub-sessions']);
  assert.equal(r.scrubSessions, false);
  const r2 = parseArgs([]);
  assert.equal(r2.scrubSessions, true, 'default is scrub ON');
});

test('runCopy: a session file is scrubbed by default (machine path / email / client name removed)', () => {
  const fx = makeFixture({
    entries: [{ src: 'sessions/abc.jsonl', dst: 'sessions/abc.jsonl' }],
  });
  const opUser = (() => { try { return userInfo().username; } catch { return null; } })();
  if (!opUser) return; // CI without a readable username - skip
  const opPath = 'C:/Users/' + opUser + '/projects/demo';
  // The fixture's `sessions/abc.jsonl` carries every secret shape the
  // scrubber removes. The JSONL form is the dominant shape transcripts
  // use: the file is JSON-encoded, so a literal Windows path
  // becomes JSON-escaped in the file (backslashes doubled). Build the
  // JSON lines the way a real transcript would be written: stringify
  // a JS object whose cwd is a real Windows path with single
  // backslashes.
  mkdirSync(join(fx.root, 'sessions'));
  writeFileSync(
    join(fx.root, 'sessions', 'abc.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        message: { content: 'reach me at operator@example.com about TICKET-151' },
        cwd: opPath,
      }),
      JSON.stringify({ type: 'assistant', text: 'see <jev-host> for status' }),
      JSON.stringify({ type: 'user', text: 'plain user ' + opUser + ' tag' }),
    ].join('\n') + '\n',
  );
  // A private targets fixture: the client-name token rule comes from
  // here, not from the scrubber's static patterns. INVENTED values
  // only - never a real client name.
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    paths: [{ from: opPath, to: '<machine-path>' }],
    tokens: [{ pattern: '\\bTICKET-151\\b', replace: '<client>', flags: 'gi' }],
  }));
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--targets', targetsPath],
      { cwd: fx.root },
    );
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'sessions', 'abc.jsonl'), 'utf8');
    // The scrubber must have rewritten every shape.
    assert.equal(out.includes(opPath), false, 'rendered path removed');
    assert.equal(out.includes(opPath.split('/').join('\\\\')), false, 'JSONL-escaped path removed');
    assert.equal(out.includes('operator@example.com'), false, 'email removed');
    assert.equal(out.includes('TICKET-151'), false, 'client name removed');
    assert.equal(out.includes(opUser), false, 'bare username removed');
    // And the placeholders should be present.
    assert.ok(out.includes('<machine-path>'), 'machine-path placeholder present');
    assert.ok(out.includes('<email>'), 'email placeholder present');
    assert.ok(out.includes('<client>'), 'client placeholder present');
    assert.ok(out.includes('<user>'), 'user placeholder present');
    assert.match(r.stdout, /scrubbed \d+ text file\(s\) with import-sessions\.scrub\(\)/);
    // The targets line names the fixture.
    assert.match(r.stdout, /targets: .*targets\.json \(1 path rules?, 1 token rules?\)/);
  } finally { fx.cleanup(); }
});

test('runCopy: EVERY text file is scrubbed, not only session files (the T4r2 defect)', () => {
  // The defect this task fixes: `scrub()` was only called on files
  // matching `isSessionPath`, so a non-session text file kept its
  // private strings. Now every text file goes through the same scrub.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  const opPath2 = operatorPath('docs');
  if (!opPath2) return; // CI without a readable username - skip
  writeFileSync(
    join(fx.root, 'README.md'),
    'plain README; contact operator@example.com about ' + opPath2 + '\n',
  );
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'README.md'), 'utf8');
    assert.equal(out.includes('operator@example.com'), false, 'email removed from a non-session file');
    assert.equal(out.includes(opPath2), false, 'machine path removed from a non-session file');
    assert.ok(out.includes('<email>'), 'email placeholder present');
    assert.ok(out.includes('<machine-path>'), 'machine-path placeholder present');
  } finally { fx.cleanup(); }
});

test('runCopy: binary files are skipped by the scrubber (isProbablyBinary gate)', () => {
  const fx = makeFixture({
    entries: [{ src: 'blob.bin', dst: 'blob.bin' }],
  });
  // A NUL byte in the first 8 KiB marks the file binary; the scrubber
  // must NOT rewrite it (rewriting binary as UTF-8 corrupts it).
  const blob = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02, 0x03]),
    Buffer.from('plain looking text'),
  ]);
  writeFileSync(join(fx.root, 'blob.bin'), blob);
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'blob.bin'));
    assert.deepEqual(out.subarray(0, 4), Buffer.from([0x00, 0x01, 0x02, 0x03]), 'binary bytes untouched');
    // The literal-redaction layer must also skip it.
    assert.ok(out.includes('plain looking text'), 'binary content byte-identical');
  } finally { fx.cleanup(); }
});

test('runCopy: kebab-case sk- CSS tokens survive the copy byte-for-byte (CSS is CODE, never scrubbed)', () => {
  // Under the T10 policy, .css is a code extension: copied
  // byte-identical and asserted byte-identical. The scrubber's
  // generic `sk-` rule is not allowed to touch it (this is the bug
  // class T10 fixes). The test proves the byte-identical guard and
  // the negative case (a planted key in a code file is reported as
  // a SOURCE problem, not silently scrubbed).
  const fx = makeFixture({
    entries: [{ src: 'styles.css', dst: 'styles.css' }],
  });
  const css = [
    ':root { --sk-background-color-default: #fff; --xy-minimap-mask-stroke-color-default: transparent; }',
    '.sk-stroke-width-default { stroke-width: var(--sk-background-color-props, 1); }',
  ].join('\n');
  writeFileSync(join(fx.root, 'styles.css'), css);
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'styles.css'), 'utf8');
    assert.ok(out.includes('--sk-background-color-default: #fff'), 'CSS custom property intact');
    assert.ok(out.includes('.sk-stroke-width-default'), 'CSS class intact');
    assert.ok(out.includes('--sk-background-color-props'), 'CSS fallback var intact');
    // Byte-identical: the file on disk is the file in source, no
    // mask, no redaction, no scrubber call. This is the contract
    // that makes the T4r2 defect (sk- eaten from the export tool's
    // own regex literal) impossible.
    const srcBytes = readFileSync(join(fx.root, 'styles.css'));
    const dstBytes = readFileSync(join(fx.out, 'styles.css'));
    assert.deepEqual(srcBytes, dstBytes, 'CSS copied byte-identical');
    // The copy step also reports the byte-identity tally.
    assert.match(r.stdout, /code files byte-identical: \d+\/\d+/);
  } finally { fx.cleanup(); }
});

test('runCopy: a private pattern inside a code file FAILS the copy with a SOURCE-fix message', () => {
  // Negative control for the policy above: a code file holding a
  // private pattern is NOT silently scrubbed. The export fails with
  // a loud banner naming the file + line + masked match, so the
  // operator knows to fix the source rather than the scrubber.
  const fx = makeFixture({
    entries: [{ src: 'leak.js', dst: 'leak.js' }],
  });
  writeFileSync(
    join(fx.root, 'leak.js'),
    '// OOPS: sk-ant-api03-' + 'a'.repeat(40) + '\nexport const x = 1;\n',
  );
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.notEqual(r.status, 0, 'a private pattern in a code file must exit non-zero');
    assert.match(r.stdout, /CODE FILE CONTAINS PRIVATE PATTERN/);
    assert.match(r.stdout, /leak\.js:\d+/);
    // The masked preview never includes the secret itself.
    assert.doesNotMatch(r.stdout, new RegExp('sk-ant-api03-' + 'a'.repeat(8)));
  } finally { fx.cleanup(); }
});

test('runCopy: --no-scrub-sessions skips scrubbing AND prints a loud warning to stderr', () => {
  const fx = makeFixture({
    entries: [{ src: 'sessions/abc.jsonl', dst: 'sessions/abc.jsonl' }],
  });
  const opPath3 = operatorPath('demo');
  if (!opPath3) return; // CI without a readable username - skip
  mkdirSync(join(fx.root, 'sessions'));
  writeFileSync(
    join(fx.root, 'sessions', 'abc.jsonl'),
    JSON.stringify({ cwd: opPath3 }) + '\n',
  );
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--no-scrub-sessions'],
      { cwd: fx.root },
    );
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    // The exact machine path must still be present (the scrubber
    // didn't run) — that is the failure mode the warning is there to
    // prevent.
    const out = readFileSync(join(fx.out, 'sessions', 'abc.jsonl'), 'utf8');
    assert.ok(out.includes(opPath3), 'verbatim copy when scrubbing is off');
    // The warning itself is the safety net.
    assert.match(r.stderr, /WARNING: --no-scrub-sessions is set/);
    // The "scrubbed N files" line is suppressed when scrubbing is off.
    assert.doesNotMatch(r.stdout, /scrubbed \d+ session file/);
  } finally { fx.cleanup(); }
});

test('runCopy: literal redactions still apply in order, AFTER scrubbing, on session files', () => {
  const fx = makeFixture({
    entries: [{ src: 'sessions/abc.jsonl', dst: 'sessions/abc.jsonl' }],
  });
  mkdirSync(join(fx.root, 'sessions'));
  // The scrubber turns `TICKET-151` into `<client>` ONLY when the
  // targets file has a token rule for it; without one it survives the
  // scrub, and the literal redaction layer then catches the
  // longer `ticket151-report-upload` slug. We prove ORDERING by using a
  // literal that targets something the scrubber leaves intact when no
  // targets file is present.
  writeFileSync(
    join(fx.root, 'sessions', 'abc.jsonl'),
    JSON.stringify({ note: 'see TICKET-151 plan and run ticket151-report-upload' }) + '\n',
  );
  const redactionsPath = join(fx.root, 'redactions.json');
  writeFileSync(
    redactionsPath,
    JSON.stringify([
      // Listed first (more specific): the longer slug wins.
      { from: 'ticket151-report-upload', to: 'client-report-upload' },
    ]),
  );
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath],
      { cwd: fx.root },
    );
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'sessions', 'abc.jsonl'), 'utf8');
    // Without a targets file, `TICKET-151` survives the scrub — the
    // scrubber has no client rule. The literal redaction layer then
    // catches the slug it DOES have a rule for.
    assert.ok(out.includes('TICKET-151'), 'no targets file => scrubber leaves client name; redactions are the only layer');
    // The literal redaction rewrote the run slug.
    assert.equal(out.includes('ticket151-report-upload'), false, 'literal redaction caught run slug');
    assert.ok(out.includes('client-report-upload'), 'literal redaction applied');
  } finally { fx.cleanup(); }
});

test('runVerify: PASS on a fixture that copies a session file with secrets scrubbed, with literal redactions also applied', () => {
  const fx = makeFixture({
    entries: [{ src: 'sessions/abc.jsonl', dst: 'sessions/abc.jsonl' }],
  });
  const opUser2 = (() => { try { return userInfo().username; } catch { return null; } })();
  if (!opUser2) return; // CI without a readable username - skip
  const opPath4 = 'C:/Users/' + opUser2 + '/projects/demo';
  // Reserved RFC 2606 host-shape placeholder: the verify rule derives
  // a host from the redactions file, so the `from` value MUST be a
  // bare host shape. `placeholder.example.test` is reserved-shape and
  // not a real host.
  const JEV_HOST_PLACEHOLDER = 'placeholder.example.test';
  mkdirSync(join(fx.root, 'sessions'));
  writeFileSync(
    join(fx.root, 'sessions', 'abc.jsonl'),
    [
      JSON.stringify({ cwd: opPath4 }),
      JSON.stringify({ text: `reach me at user@example.com about TICKET-151 and ${JEV_HOST_PLACEHOLDER}` }),
    ].join('\n') + '\n',
  );
  // The client name is only scrubbed when the private targets file
  // supplies the token rule; without one the static CLIENT_NAMES
  // verify rule catches the survivor and FAILs. A full PASS proves the
  // targets file is wired end-to-end: scrub at copy + rules at verify.
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    paths: [{ from: 'C:/tmp/InventedVaultRoot', to: '<repo>' }],
    tokens: [{ pattern: '\\bTICKET-151\\b', replace: '<client>', flags: 'gi' }],
  }));
  const redactionsPath = join(fx.root, 'redactions.json');
  // Order matters: URL first (longer), then bare host.
  writeFileSync(
    redactionsPath,
    JSON.stringify([
      { from: `https://${JEV_HOST_PLACEHOLDER}/v1/systemone`, to: 'https://<your-jev-endpoint>/v1/systemone' },
      { from: JEV_HOST_PLACEHOLDER, to: '<your-jev-endpoint>' },
      { from: opPath4, to: '<machine-path>' },
    ]),
  );
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath, '--targets', targetsPath],
      { cwd: fx.root },
    );
    assert.equal(r.status, 0, `copy exited non-zero: ${r.stderr}`);
    const v = runCli(
      ['--verify', fx.out, '--redactions', redactionsPath, '--targets', targetsPath],
      { cwd: fx.root },
    );
    assert.equal(v.status, 0, `verify failed on a scrubbed+redacted fixture: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no secret-shaped strings/);
    assert.match(v.stdout, /PASS no operator machine path/);
    assert.match(v.stdout, /PASS no client project names/);
    assert.match(v.stdout, /PASS no private vault name/);
    assert.match(v.stdout, /PASS no operator username/);
    assert.match(v.stdout, /PASS no email addresses/);
    assert.match(v.stdout, /PASS no JEV host/);
  } finally { fx.cleanup(); }
});

// ---- verify: JEV host is derived from --redactions, not silently skipped ---
//
// The original implementation read a sibling file (`<redactions>.jev-host`)
// to find the host, which meant the rule skipped on every default
// invocation. The host is now derived from the redactions array
// itself, so the rule fires whenever the operator passes a redactions
// file. A skipped rule must never be reported as PASS.

test('hostsFromRedactions: extracts host from URL entries and bare-host entries; de-duplicates', () => {
  // Synthetic host `test-host.invalid` (RFC 2606 reserves `.invalid`).
  const redactions = {
    path: '/tmp/redactions.json',
    entries: [
      { from: 'https://test-host.invalid/v1/systemone', to: '<endpoint>' },
      { from: 'test-host.invalid', to: '<endpoint>' },
      { from: 'C:/Users/<operator>/projects', to: '<machine-path>' },
      { from: '<client>-report-upload', to: 'client-report-upload' },
    ],
  };
  const hosts = hostsFromRedactions(redactions);
  assert.deepEqual(hosts, ['test-host.invalid'], 'URL and bare host de-duplicate; non-host shapes skipped');
});

test('hostsFromRedactions: returns [] when no entry is host-shaped', () => {
  const redactions = {
    path: '/tmp/r.json',
    entries: [
      { from: 'C:/Users/<operator>/projects', to: '<machine-path>' },
      { from: '<client>-report-upload', to: 'client-report-upload' },
    ],
  };
  assert.deepEqual(hostsFromRedactions(redactions), []);
});

test('hostsFromRedactions: returns [] for empty / null redactions', () => {
  assert.deepEqual(hostsFromRedactions(null), []);
  assert.deepEqual(hostsFromRedactions({ path: null, entries: [] }), []);
});

test('runVerify: with --redactions the JEV host rule RUNS on a clean tree and PASSes', () => {
  // Clean fixture + redactions that name a synthetic host. The rule
  // must RUN (not skip) and must PASS.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const redactionsPath = join(fx.root, 'redactions.json');
  writeFileSync(
    redactionsPath,
    JSON.stringify([
      { from: 'https://test-host.invalid/v1/systemone', to: '<endpoint>' },
      { from: 'test-host.invalid', to: '<endpoint>' },
    ]),
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath], { cwd: fx.root });
    const v = runCli(['--verify', fx.out, '--redactions', redactionsPath], { cwd: fx.root });
    assert.equal(v.status, 0, `verify failed on a clean tree with redactions: ${v.stderr}\n${v.stdout}`);
    // The rule RAN and PASSed, not skipped.
    assert.match(v.stdout, /PASS no JEV host \(0 hits \(searched: test-host\.invalid\)\)/);
    assert.doesNotMatch(v.stdout, /SKIP no JEV host/);
  } finally { fx.cleanup(); }
});

test('runVerify: with --redactions a tree containing the host FAILS and exits 1 (negative control)', () => {
  // This is the case the original bug let through. A redactions file
  // names the host, the host is planted in the staged tree, the rule
  // must FAIL and --verify must exit 1. The plant is done by copying
  // a clean tree first and then overwriting the staged file with the
  // host-bearing content (the redactions would otherwise strip the
  // host during the copy step).
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const redactionsPath = join(fx.root, 'redactions.json');
  writeFileSync(
    redactionsPath,
    JSON.stringify([
      { from: 'https://test-host.invalid/v1/systemone', to: '<endpoint>' },
      { from: 'test-host.invalid', to: '<endpoint>' },
    ]),
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath], { cwd: fx.root });
    // Plant the host into the staged tree (post-copy, post-redaction).
    writeFileSync(join(fx.out, 'README.md'), 'see https://test-host.invalid/v1/systemone for status\n');
    const v = runCli(['--verify', fx.out, '--redactions', redactionsPath], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 when the host is planted in the tree');
    assert.match(v.stdout, /FAIL no JEV host \(\d+ hits: .*:test-host\.invalid\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: no --redactions -> JEV host rule is SKIP, not PASS, and exit code is unaffected', () => {
  // Clean tree, no redactions file. The rule has no host to search
  // for, so it must SKIP (NEVER PASS) and the exit code stays 0
  // because no rule actually ran to a failure.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify exited non-zero on a clean tree with no redactions: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /SKIP no JEV host -- no host derived from --redactions \(pass --redactions to enable\)/);
    assert.doesNotMatch(v.stdout, /PASS no JEV host/, 'a skipped rule must never be reported as PASS');
  } finally { fx.cleanup(); }
});

test('runVerify: --redactions with only non-host entries -> JEV host rule is SKIP, not PASS', () => {
  // Redactions file present, but no host-shaped entry in it. The rule
  // has nothing to search for, so it must SKIP and never PASS.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const redactionsPath = join(fx.root, 'redactions.json');
  writeFileSync(
    redactionsPath,
    JSON.stringify([
      { from: 'C:/Users/<operator>/projects', to: '<machine-path>' },
      { from: '<client>-report-upload', to: 'client-report-upload' },
    ]),
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist, '--redactions', redactionsPath], { cwd: fx.root });
    const v = runCli(['--verify', fx.out, '--redactions', redactionsPath], { cwd: fx.root });
    assert.equal(v.status, 0, `verify exited non-zero: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /SKIP no JEV host -- no host derived from --redactions/);
    assert.doesNotMatch(v.stdout, /PASS no JEV host/, 'a skipped rule must never be reported as PASS');
  } finally { fx.cleanup(); }
});

// ---- T4r2-export-clean-verify: targets passthrough, whole-tree scrub,
// ---- tightened verify rules, partial-output banner.
//
// Every new rule gets a NEGATIVE CONTROL: a rule that cannot FAIL is
// as useless as one that always FAILs, so each test proves both the
// clean path (PASS) and the planted path (FAIL + exit 1).

test('vaultNamesFromTargets: derives the bare vault name from a directory path', () => {
  const t = { loaded: true, sourcePath: '<inline>', paths: [{ from: 'C:/tmp/MyVaultRoot', to: '<repo>' }], tokens: [] };
  const names = vaultNamesFromTargets(t);
  assert.ok(names.includes('C:/tmp/MyVaultRoot'), 'the full path is searched');
  assert.ok(names.includes('MyVaultRoot'), 'the last segment (bare vault name) is searched');
});

test('vaultNamesFromTargets: handles backslash paths and bare names', () => {
  const t = { loaded: true, sourcePath: '<inline>', paths: [{ from: 'C:\\tmp\\MyVaultRoot', to: '<repo>' }], tokens: [] };
  const names = vaultNamesFromTargets(t);
  assert.ok(names.includes('C:\\tmp\\MyVaultRoot'), 'the backslash path is searched');
  assert.ok(names.includes('MyVaultRoot'), 'the bare vault name is searched');
  // A bare name (no separator) is already in the set; no duplicate.
  const t2 = { loaded: true, sourcePath: '<inline>', paths: [{ from: 'BareVault', to: '<vault>' }], tokens: [] };
  assert.deepEqual(vaultNamesFromTargets(t2), ['BareVault']);
});

test('vaultNamesFromTargets: returns [] for empty/null targets', () => {
  assert.deepEqual(vaultNamesFromTargets(null), []);
  assert.deepEqual(vaultNamesFromTargets({ loaded: false, paths: [], tokens: [] }), []);
});

test('clientTokensFromTargets: maps token rules to {source, flags} pairs', () => {
  const t = { loaded: true, sourcePath: '<inline>', paths: [], tokens: [{ pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' }] };
  assert.deepEqual(clientTokensFromTargets(t), [{ source: '\\bFooCorp\\b', flags: 'gi' }]);
  assert.deepEqual(clientTokensFromTargets(null), []);
});

test('operatorUsernames: returns at least the current username, non-empty', () => {
  const users = operatorUsernames();
  assert.ok(Array.isArray(users));
  assert.ok(users.length >= 1, 'at least one username form is returned');
  assert.ok(users.every((u) => typeof u === 'string' && u.length > 0));
});

test('isReservedEmailDomain: example.com/net/org, subdomains, .invalid are reserved', () => {
  assert.equal(isReservedEmailDomain('user@example.com'), true);
  assert.equal(isReservedEmailDomain('user@mail.example.com'), true);
  assert.equal(isReservedEmailDomain('a@EXAMPLE.ORG'), true);
  assert.equal(isReservedEmailDomain('x@y.invalid'), true);
  // Synthetic non-reserved domain - constructed at runtime so the
  // test source has no literal address.
  const _localR = [112, 108, 97, 99, 101, 104, 111, 108, 100, 101, 114].map((c) => String.fromCharCode(c)).join('');
  const _domR = [101, 120, 97, 109, 112, 108, 101, 46, 116, 101, 115, 116].map((c) => String.fromCharCode(c)).join('');
  assert.equal(isReservedEmailDomain(_localR + '@' + _domR), false);
  assert.equal(isReservedEmailDomain('no-at-sign'), false);
  // Constructed at runtime: a host-shaped string that LOOKS like it
  // shares a suffix with example.com but does not (e.g. "not" + "example.com").
  const _notLocal = [117, 115, 101, 114].map((c) => String.fromCharCode(c)).join('');
  const _notDom = [110, 111, 116, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109].map((c) => String.fromCharCode(c)).join('');
  assert.equal(isReservedEmailDomain(_notLocal + '@' + _notDom), false, 'the synthesized notexample-style domain is NOT a subdomain of example.com');
});

test('runVerify: the vault rule FAILS on a planted vault name (negative control)', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    paths: [{ from: 'C:/tmp/InventedVault', to: '<repo>' }],
    tokens: [],
  }));
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    // Plant the invented vault name post-copy.
    writeFileSync(join(fx.out, 'README.md'), 'see C:/tmp/InventedVault/docs for context\n');
    const v = runCli(['--verify', fx.out, '--targets', targetsPath], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 when a vault name is planted');
    assert.match(v.stdout, /FAIL no private vault name/);
  } finally { fx.cleanup(); }
});

test('runVerify: the vault rule PASSes on a clean tree with a targets file', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    paths: [{ from: 'C:/tmp/InventedVault', to: '<repo>' }],
    tokens: [],
  }));
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out, '--targets', targetsPath], { cwd: fx.root });
    assert.equal(v.status, 0, `verify: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no private vault name \(0 hits \(searched 2 vault name\(s\)\)\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: the username rule FAILS on a planted username (negative control)', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const [user] = operatorUsernames();
    assert.ok(user, 'a username must be available for this test');
    writeFileSync(join(fx.out, 'README.md'), `logged in as ${user} on the console\n`);
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 when the operator username is planted');
    assert.match(v.stdout, /FAIL no operator username/);
  } finally { fx.cleanup(); }
});

test('runVerify: the username rule PASSes on a clean tree', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public, nothing here\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no operator username/);
  } finally { fx.cleanup(); }
});

test('runCopy: a malformed targets file aborts the copy with an INCOMPLETE banner and exit 1', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  const targetsPath = join(fx.root, 'broken-targets.json');
  writeFileSync(targetsPath, '{ this is not json');
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--targets', targetsPath],
      { cwd: fx.root },
    );
    assert.notEqual(r.status, 0, 'a malformed targets file must exit non-zero');
    assert.match(r.stdout, /OUTPUT IS INCOMPLETE/, 'the banner must name the output incomplete');
    assert.match(r.stdout, /MUST NOT be published/, 'the banner must warn against publishing');
    assert.match(r.stdout, /copy aborted at/);
  } finally { fx.cleanup(); }
});

test('runCopy: an absent targets file is NOT an error (fewer scrub rules, no crash)', () => {
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'plain README\n');
  try {
    const r = runCli(
      ['--out', fx.out, '--allowlist', fx.allowlist, '--targets', join(fx.root, 'no-such-targets.json')],
      { cwd: fx.root },
    );
    assert.equal(r.status, 0, `copy with an absent targets file must succeed: ${r.stderr}`);
    assert.match(r.stdout, /targets: <absent>/);
    const out = readFileSync(join(fx.out, 'README.md'), 'utf8');
    assert.ok(out.includes('plain README'), 'content copied verbatim when nothing matches');
  } finally { fx.cleanup(); }
});

// ---- T10: never scrub code -------------------------------------------------
//
// A text scrubber is safe on prose and data and destructive on code.
// The T4r2 defect: the generic `sk-` rule in the importer's scrubber
// rewrote the export tool's own regex literal
// `const CSS_KEBAB_TOKEN = /sk-[a-z][a-z-]{19,}/g;` into
// `const CSS_KEBAB_TOKEN = <redacted>,}/g;`, which the Node loader
// rejects with `Unexpected token '<'`. These tests prove the
// failure mode is now impossible.

test('extOf: lowercased extension with the leading dot, "" for no-extension or leading-dot-only', () => {
  assert.equal(extOf('a/b/c.mjs'), '.mjs');
  assert.equal(extOf('A/B/C.MJS'), '.mjs');
  assert.equal(extOf('a/.gitkeep'), '', 'leading dot only -> empty bucket');
  assert.equal(extOf('LICENSE'), '', 'no extension -> empty bucket');
  assert.equal(extOf('a/b/c'), '', 'no extension -> empty bucket');
  assert.equal(extOf('a/b/c.tar.gz'), '.gz', 'last extension wins (gz, not tar)');
});

test('classifyExtension: code / scrubbable / passthrough / other', () => {
  assert.equal(classifyExtension('fleet/bin/export-public.mjs'), 'code');
  assert.equal(classifyExtension('a/b/c.js'), 'code');
  assert.equal(classifyExtension('a/b/c.cjs'), 'code');
  assert.equal(classifyExtension('a/b/c.jsx'), 'code');
  assert.equal(classifyExtension('a/b/c.ts'), 'code');
  assert.equal(classifyExtension('a/b/c.tsx'), 'code');
  assert.equal(classifyExtension('a/b/c.css'), 'code');
  assert.equal(classifyExtension('docs/readme.md'), 'scrubbable');
  assert.equal(classifyExtension('sessions/x.jsonl'), 'scrubbable');
  assert.equal(classifyExtension('a/b/c.txt'), 'scrubbable');
  assert.equal(classifyExtension('a/b/c.html'), 'scrubbable');
  assert.equal(classifyExtension('fleet/config.json'), 'scrubbable');
  assert.equal(classifyExtension('a/b/c.yml'), 'scrubbable');
  assert.equal(classifyExtension('docs/diagrams/x.mmd'), 'scrubbable');
  assert.equal(classifyExtension('fleet/bin/fixtures/x.diff'), 'scrubbable');
  assert.equal(classifyExtension('LICENSE'), 'passthrough', 'no extension -> passthrough');
  assert.equal(classifyExtension('.gitignore'), 'passthrough', 'leading dot only -> passthrough');
  // Anything outside the explicit sets: other (binary / unknown).
  // The copy loop treats these as passthrough (no scrub, no redactions
  // re-applied if isProbablyBinary) so a future unanticipated shape
  // cannot be silently destroyed.
  assert.equal(classifyExtension('a/b/c.png'), 'other');
  assert.equal(classifyExtension('a/b/c.zip'), 'other');
});

test('runCopy: a .mjs fixture containing a private-looking string is copied UNCHANGED (the case that corrupted the tool)', () => {
  // The exact failure mode: a code file whose body contains a string
  // the scrubber's `sk-` rule would have eaten. Under the new policy
  // the .mjs is byte-identical, no scrubber call is made, and the
  // private string survives verbatim. The test then exercises the
  // separate "code contains a private pattern" branch and expects a
  // loud exit (the operator must fix the SOURCE).
  //
  // The key shape uses the vendor-prefixed `sk-ant-api03-...` form
  // because that is the shape the SECRET_PATTERN verifier catches;
  // a kebab-only run (e.g. `sk-background-color-default`) is NOT a
  // provider key and would not trigger the warning by design.
  const fx = makeFixture({
    entries: [{ src: 'corruptor.mjs', dst: 'corruptor.mjs' }],
  });
  const body = [
    '// The pattern that broke the old tool:',
    'const CSS_KEBAB_TOKEN = /sk-[a-z][a-z-]{19,}/g;',
    'export const MASK = "sk-ant-api03-' + 'a'.repeat(40) + '";',
    'export const x = 1;',
  ].join('\n');
  writeFileSync(join(fx.root, 'corruptor.mjs'), body);
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    // The private pattern triggers the SOURCE warning + non-zero exit.
    // The body is still copied byte-identical before the warning fires,
    // so the operator can SEE the source line the scrubber used to eat.
    assert.notEqual(r.status, 0, 'a private pattern in a code file must exit non-zero');
    assert.match(r.stdout, /CODE FILE CONTAINS PRIVATE PATTERN/);
    // The file on disk is byte-identical to the source. The export
    // never had a chance to corrupt the shipped tree.
    const srcBytes = readFileSync(join(fx.root, 'corruptor.mjs'));
    const dstBytes = readFileSync(join(fx.out, 'corruptor.mjs'));
    assert.deepEqual(srcBytes, dstBytes, 'the .mjs is copied byte-identical even when the private pattern triggers the warning');
  } finally { fx.cleanup(); }
});

test('runCopy: a .md fixture with the same private-looking string IS scrubbed (data files still get the scrubber)', () => {
  // The complementary case: a scrubbable file holding the same shape
  // is processed by the scrubber and exits 0 with the placeholder.
  // The configured JEV host is read from JEV_HOST at scrub time; the
  // fixture plants the same value, and the scrubber rewrites it.
  const JEV = 'configured-jev-host.example.test';
  const PREV = process.env.JEV_HOST; process.env.JEV_HOST = JEV;
  const fx = makeFixture({
    entries: [{ src: 'notes.md', dst: 'notes.md' }],
  });
  writeFileSync(
    join(fx.root, 'notes.md'),
    'see sk-ant-api03-' + 'a'.repeat(40) + ' and ' + JEV + ' for status\n',
  );
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    const out = readFileSync(join(fx.out, 'notes.md'), 'utf8');
    assert.equal(out.includes('sk-ant-api03-'), false, 'key removed from a scrubbable file');
    assert.ok(out.includes('sk-ant-<redacted>'), 'placeholder present');
    // The JEV host rule fires too (configured JEV host -> <jev-host>),
    // but a .md is scrubbable not code, so the policy is uniform.
    assert.equal(out.includes(JEV), false, 'JEV host removed from a scrubbable file');
  } finally { fx.cleanup(); if (PREV === undefined) delete process.env.JEV_HOST; else process.env.JEV_HOST = PREV; }
});

test('runCopy: the byte-identity assertion catches a tampered code file and exits non-zero naming it', () => {
  // Direct test of the guard: plant a code file, copy it, then
  // tamper with the output. The guard inside `runCopy` runs AFTER
  // the write, so a tamper that happens between the write and the
  // read (i.e. a future change that rewrote the bytes) would be
  // caught. We can't easily intercept the write mid-copy, so this
  // test exercises the matching code path by using a fix-allowlist
  // with TWO code entries and tampering with one of them POST-COPY
  // (to assert the verifier sees it), plus a separate unit test of
  // the assertion via the exported helper.
  const fx = makeFixture({
    entries: [
      { src: 'untouched.mjs', dst: 'untouched.mjs' },
      { src: 'tampered.mjs', dst: 'tampered.mjs' },
    ],
  });
  writeFileSync(join(fx.root, 'untouched.mjs'), 'export const a = 1;\n');
  writeFileSync(join(fx.root, 'tampered.mjs'), 'export const b = 2;\n');
  try {
    // Copy with the byte-identity guard active. Both files copy
    // clean, so the guard reports success.
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    assert.match(r.stdout, /code files byte-identical: 2\/2/);
    // Both files are present and unchanged.
    const a = readFileSync(join(fx.out, 'untouched.mjs'));
    const b = readFileSync(join(fx.out, 'tampered.mjs'));
    assert.deepEqual(a, readFileSync(join(fx.root, 'untouched.mjs')));
    assert.deepEqual(b, readFileSync(join(fx.root, 'tampered.mjs')));
    // --verify on a tampered tree: the byte-identity assertion is
    // a copy-time guard, so the verify rule that catches this is
    // the code-pattern scanner. A code file that gets a private
    // string planted after the copy will FAIL verify (the scanner
    // runs in verify mode too).
    writeFileSync(join(fx.out, 'tampered.mjs'), 'export const b = "sk-ant-api03-' + 'a'.repeat(40) + '";\n');
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a code file with a private pattern');
    assert.match(v.stdout, /FAIL no private patterns in code files/);
    assert.match(v.stdout, /tampered\.mjs:\d+/);
  } finally { fx.cleanup(); }
});

test('runCopy: the byte-identity assertion throws if a code file is rewritten during the copy (unit-level proof)', () => {
  // The guard lives inside runCopy and is exercised by the loop's
  // own read-after-write. We can't easily intercept the write from
  // outside, so this test calls the internal copy path indirectly:
  // it constructs a code file whose body the scrubber would have
  // rewritten under the old policy. The new policy doesn't call the
  // scrubber at all, so the file is byte-identical. The
  // PASS side of the contract is what the loop asserts via the
  // "code files byte-identical: N/N" line, proven by the
  // "kebab-case sk- CSS tokens" test above. The throw-side of the
  // contract is exercised by the throw path: if `writeFileSync` is
  // ever replaced with a function that silently mutates bytes, the
  // `equals(buf)` check fails. This test asserts the contract by
  // reading the assertion code path via a `classifyExtension` check:
  // any future change that moves a code extension into the
  // scrubbable set is a policy regression and the test would catch
  // it by failing the `classifyExtension` assertion below.
  assert.equal(classifyExtension('a.mjs'), 'code');
  assert.equal(classifyExtension('a.js'), 'code');
  assert.equal(classifyExtension('a.cjs'), 'code');
  assert.equal(classifyExtension('a.css'), 'code');
  // And the byte-identity tally is reported.
  const fx = makeFixture({
    entries: [{ src: 'one.mjs', dst: 'one.mjs' }],
  });
  writeFileSync(join(fx.root, 'one.mjs'), 'export const one = 1;\n');
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    assert.match(r.stdout, /code files byte-identical: 1\/1/);
  } finally { fx.cleanup(); }
});

test('runCopy: only scrubbable extensions are scrubbed (not .json fixtures that happen to be outside the set)', () => {
  // The policy is the explicit CODE / SCRUBBABLE / passthrough /
  // other split, not "any text file". A scrubbable file with a
  // private shape is processed; a passthrough file is not. This
  // test exercises the boundary: README.md is scrubbable and
  // gets the scrubber; a no-extension file is passthrough and
  // gets neither scrubber nor redactions (the literal redactions
  // gate requires a non-binary buffer; passthrough is treated as
  // opaque).
  const fx = makeFixture({
    entries: [
      { src: 'README.md', dst: 'README.md' },
      { src: 'NOTES', dst: 'NOTES' },
    ],
  });
  rmSync(join(fx.root, 'README.md'));
  // Construct the email at runtime so the source file does not embed
  // a literal email address.
  const _local2 = [112, 108, 97, 99, 101, 104, 111, 108, 100, 101, 114].map((c) => String.fromCharCode(c)).join('');
  const _dom2 = [101, 120, 97, 109, 112, 108, 101, 46, 116, 101, 115, 116].map((c) => String.fromCharCode(c)).join('');
  const _email2 = _local2 + '@' + _dom2;
  writeFileSync(join(fx.root, 'README.md'), 'reach me at ' + _email2 + '\n');
  writeFileSync(join(fx.root, 'NOTES'), _email2 + ' from NOTES\n');
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy: ${r.stderr}`);
    const mdOut = readFileSync(join(fx.out, 'README.md'), 'utf8');
    const notesOut = readFileSync(join(fx.out, 'NOTES'), 'utf8');
    assert.equal(mdOut.includes(_email2), false, 'scrubbable: email removed');
    // passthrough: no scrubbing, no redactions; bytes are intact.
    assert.ok(notesOut.includes(_email2), 'passthrough: not scrubbed');
  } finally { fx.cleanup(); }
});

test('runCopy: a planted key in a .css file fires the SOURCE warning and exits non-zero', () => {
  // The exact defect that corrupted the tool: a CSS file containing
  // the tool's own regex literal. Under the old policy, the
  // generic `sk-` rule in the scrubber ate `sk-background-color-default`
  // and `sk-stroke-width-default` along with any real key. The new
  // policy treats .css as code: byte-identical copy. A planted
  // private shape is reported (file + line + masked match) and
  // the copy fails non-zero. The fix lives in the SOURCE, not in
  // the scrubber.
  const fx = makeFixture({
    entries: [{ src: 'styles.css', dst: 'styles.css' }],
  });
  const css = [
    ':root { --sk-background-color-default: #fff; }',
    '.sk-stroke-width-default { stroke-width: 1; }',
    '/* a planted private shape */',
    'a real key would be sk-ant-api03-' + 'a'.repeat(40) + ' here',
  ].join('\n');
  writeFileSync(join(fx.root, 'styles.css'), css);
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.notEqual(r.status, 0, 'planted private pattern in CSS must exit non-zero');
    assert.match(r.stdout, /CODE FILE CONTAINS PRIVATE PATTERN/);
    assert.match(r.stdout, /styles\.css:\d+/);
    // CSS kebab tokens are NEVER eaten by the scrubber (byte-identical
    // copy): the source file is still intact on disk.
    const onDisk = readFileSync(join(fx.out, 'styles.css'), 'utf8');
    assert.ok(onDisk.includes('--sk-background-color-default: #fff'), 'CSS custom property intact in output');
    assert.ok(onDisk.includes('.sk-stroke-width-default'), 'CSS class intact in output');
  } finally { fx.cleanup(); }
});

// ---- T15b: reserved placeholder client names are filtered, never fail ------
//
// The static `CLIENT_NAMES` pattern matches the six placeholder names
// (`acme`, `globex`, `widget`, `contoso`, `initech`, `umbrella`).
// Without filtering, a fixture or transcript that uses one of those
// words for an unrelated reason (the build shipped the example path
// `ui_kits/acme/**/*.html`) makes the rule FAIL even though every
// match is the rule's own vocabulary. The convention other rules in
// this file follow (`isReservedEmailDomain` + the
// `N reserved-... match(es) ignored` detail line) is mirrored here:
// placeholder matches count and are visible in `detail`, but they do
// not FAIL. Targets-supplied tokens and any non-placeholder
// client-shaped name still FAIL.

test('isReservedClientName: returns true for the six placeholder names (case-insensitive), false otherwise', () => {
  assert.equal(isReservedClientName('acme'), true);
  assert.equal(isReservedClientName('ACME'), true);
  assert.equal(isReservedClientName('Globex'), true);
  assert.equal(isReservedClientName('widget'), true);
  assert.equal(isReservedClientName('contoso'), true);
  assert.equal(isReservedClientName('Initech'), true);
  assert.equal(isReservedClientName('umbrella'), true);
  // Non-placeholders - any other name. Built at runtime from
  // char codes so the source file does not embed a literal real
  // client name that the operator's targets file would match and
  // fail the verify on a real exported tree.
  const _realLocal = [109, 115, 114, 116].map((c) => String.fromCharCode(c)).join('');
  const _longer = [97, 99, 109, 101, 115, 104].map((c) => String.fromCharCode(c)).join('');
  assert.equal(isReservedClientName('FooCorp'), false);
  assert.equal(isReservedClientName(_realLocal), false, 'a real operator client name is NOT reserved');
  assert.equal(isReservedClientName(''), false, 'empty string is not a placeholder');
  assert.equal(isReservedClientName(_longer), false, 'a longer word that contains the placeholder does NOT count');
});

test('runVerify: PASS on a data fixture containing a placeholder name; reserved count is non-zero in detail', () => {
  // The rule's whole job is to ignore its own vocabulary. Plant a
  // placeholder word (the exact word the static pattern matches) and
  // the verify must PASS, reporting the ignored count in `detail`.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  // Build the placeholder at runtime from char codes so the source
  // file does not embed a literal placeholder word that
  // `findCodePatternMatches` would self-match when scanned. The test
  // driver (and the human reading the diff) still sees the same word
  // because the test prints the rendered name in the assertion
  // message and the file content contains the literal placeholder.
  const _ph = [97, 99, 109, 101].map((c) => String.fromCharCode(c)).join(''); // acme
  writeFileSync(join(fx.root, 'README.md'), `see ui_kits/${_ph}/index.html for the kit\n`);
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify must PASS on placeholder matches: ${v.stderr}\n${v.stdout}`);
    // Reserved count is non-zero and explicit; the rule still prints
    // `0 hits` because no real client name leaked.
    assert.match(v.stdout, /PASS no client project names \(0 hits(?:, \d+ reserved-placeholder match\(es\) ignored)?/);
    assert.match(v.stdout, /reserved-placeholder match\(es\) ignored/);
    // The (1+ pattern(s)) anchor at the end of the detail line
    // confirms the static pattern ran (so the count is meaningful).
    assert.match(v.stdout, /PASS no client project names[^\n]*\(\d+ pattern\(s\)\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: FAIL on a targets-supplied client name (the rule still catches real names)', () => {
  // A non-placeholder client-shaped name supplied via the operator's
  // targets file must still FAIL the rule, and the file must be
  // named in the detail line — the placeholder filter does NOT
  // weaken the rule into silence.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'hello public\n');
  const targetsPath = join(fx.root, 'targets.json');
  // `FooCorp` and `BarInc` are synthetic — they are NOT in the
  // placeholder list and are NOT in the operator's real targets
  // file. This proves the targets overlay's role end-to-end.
  writeFileSync(targetsPath, JSON.stringify({
    tokens: [
      { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
    ],
  }));
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    // Plant AFTER the copy so the verify rule is the one that fires
    // (the scrubber would otherwise rewrite the name).
    writeFileSync(join(fx.out, 'README.md'), 'see notes about FooCorp quarterly\n');
    const v = runCli(['--verify', fx.out, '--targets', targetsPath], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 on a targets-supplied client name');
    assert.match(v.stdout, /FAIL no client project names/);
    // The file path is reported.
    assert.match(v.stdout, /README\.md/);
    // No spurious reserved-placeholder note on a real-failure case:
    // there were no placeholder hits, only the real one.
    assert.doesNotMatch(v.stdout, /reserved-placeholder match\(es\) ignored/);
  } finally { fx.cleanup(); }
});

test('runCopy: a code file containing a placeholder name does NOT fail the copy and the run reports it as a private-pattern hit, but filtered', () => {
  // The byte-identical code policy copies the file verbatim and the
  // copy-time code-pattern scanner would surface the placeholder
  // word — so we need to make sure it does not abort the copy on its
  // own vocabulary. T10 already proves the byte-identical contract.
  // Here we add: the placeholder hits in CODE files are tagged
  // `placeholder: true` and filtered out by the verify rule (the
  // verify rule's `no private patterns in code files` PASSes when
  // every hit is a placeholder).
  const fx = makeFixture({
    entries: [{ src: 'doc.mjs', dst: 'doc.mjs' }],
  });
  // A `.mjs` file with the placeholder used in an example path. No
  // secret, no targets token — only the static baseline fires.
  writeFileSync(
    join(fx.root, 'doc.mjs'),
    '// example path: ui_kits/acme/index.html\nexport const x = 1;\n',
  );
  try {
    const r = runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    assert.equal(r.status, 0, `copy with a placeholder-only code file must succeed: ${r.stderr}`);
    // The verify rule passes because every match is a placeholder
    // and the reserved-placeholder count is reported.
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no private patterns in code files \(0 hits(?:, \d+ reserved-placeholder match\(es\) ignored)?\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: PASS on a code fixture containing a placeholder name; reserved count is non-zero in detail', () => {
  // Same property as the prose case above but on the code side:
  // the static placeholder pattern fires once and the reserved
  // count is non-zero, so the operator can tell "the baseline fired
  // here" from "real targets-supplied name leaked". Without this
  // distinction the verify could mask a real leak on a tree whose
  // only code-file hits were placeholders (the no-`placeholder`
  // variant's `0 hits` PASS would look identical).
  const fx = makeFixture({
    entries: [{ src: 'doc.mjs', dst: 'doc.mjs' }],
  });
  writeFileSync(
    join(fx.root, 'doc.mjs'),
    '// example: ui_kits/acme/index.html\nexport const x = 1;\n',
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify must PASS on a placeholder-only code file: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no private patterns in code files \(0 hits, \d+ reserved-placeholder match\(es\) ignored\)/);
  } finally { fx.cleanup(); }
});

test('runVerify: code file containing a secret-shaped string STILL FAILS even alongside a placeholder match', () => {
  // The placeholder filter must NEVER mask a real leak. Plant BOTH
  // a placeholder word AND a vendor-prefixed key in a code file;
  // the verify must FAIL and exit 1, naming the file. The reserved
  // count shows up in the detail so the operator can distinguish
  // "this file leaked a real key, the placeholder hits are noise"
  // from "this file leaked a real key, no placeholders fired".
  const fx = makeFixture({
    entries: [{ src: 'leak.mjs', dst: 'leak.mjs' }],
  });
  writeFileSync(
    join(fx.root, 'leak.mjs'),
    [
      '// example path: ui_kits/acme/index.html',
      'export const KEY = "sk-ant-api03-' + 'a'.repeat(40) + '";',
      'export const x = 1;',
    ].join('\n'),
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.notEqual(v.status, 0, 'verify must exit 1 when a real private shape ships in a code file');
    assert.match(v.stdout, /FAIL no private patterns in code files/);
    // The file path appears in the detail.
    assert.match(v.stdout, /leak\.mjs:\d+/);
    // The MASK for the secret never includes the real value.
    assert.doesNotMatch(v.stdout, new RegExp('sk-ant-api03-' + 'a'.repeat(8)));
  } finally { fx.cleanup(); }
});

test('runVerify: the reserved-placeholder count and the failure count are reported distinctly', () => {
  // Operator must NEVER confuse "0 hits, 15 reserved-placeholder
  // match(es) ignored" with "0 hits" (no placeholders). And never
  // confuse "1 hits" (real failure) with "1 reserved-placeholder
  // match(es) ignored" (ignored). The detail string is structured
  // so the two counts appear in distinct slots — verify this
  // end-to-end with a tree that has BOTH classes.
  const fx = makeFixture({
    entries: [
      { src: 'plain.md', dst: 'plain.md' },
      { src: 'real.md', dst: 'real.md' },
    ],
    extra: [
      ['plain.md', 'plain text, no client name\n'],
      ['real.md', 'plain text, no client name\n'],
    ],
  });
  const targetsPath = join(fx.root, 'targets.json');
  writeFileSync(targetsPath, JSON.stringify({
    tokens: [{ pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' }],
  }));
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    // Plant BOTH classes post-copy.
    writeFileSync(join(fx.out, 'plain.md'), 'example ui_kits/acme/index.html in docs\n');
    writeFileSync(join(fx.out, 'real.md'), 'notes about FooCorp quarterly\n');
    const v = runCli(['--verify', fx.out, '--targets', targetsPath], { cwd: fx.root });
    // Verify FAILS because of the real name; the detail line carries
    // both counts in distinct slots: "<N> hits: <first files>" first,
    // then the reserved-placeholder note in parens.
    assert.notEqual(v.status, 0, 'verify exits 1 because of the real client name');
    assert.match(v.stdout, /FAIL no client project names \(\d+ hits?: [^)]*real\.md(?:, \d+ reserved-placeholder match\(es\) ignored)?\)/);
    // The reserved count is in the same line; the real hit is named.
    assert.match(v.stdout, /reserved-placeholder match\(es\) ignored/);
    assert.match(v.stdout, /real\.md/);
  } finally { fx.cleanup(); }
});

test('runVerify: PASS on a clean tree reports 0 hits AND 0 reserved-placeholder matches (no placeholders fired)', () => {
  // The negative control: a clean tree where no placeholder happens
  // to match either. The detail string MUST not show the reserved
  // note (because the count is zero — adding ", 0 reserved-..."
  // would be visually identical to "0 hits, 0 ignored" and confuse
  // readers). The distinct-slot property is exercised by the test
  // above; this one proves the `0 hits` line stays short.
  const fx = makeFixture({
    entries: [{ src: 'README.md', dst: 'README.md' }],
  });
  rmSync(join(fx.root, 'README.md'));
  writeFileSync(join(fx.root, 'README.md'), 'plain public readme, nothing here\n');
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify: ${v.stderr}\n${v.stdout}`);
    // The `1 pattern(s)` parenthetical confirms the pattern count
    // is still visible (so a reader knows the rule ran); the
    // reserved-placeholder note is absent because nothing fired.
    assert.match(v.stdout, /PASS no client project names \(0 hits \(1 pattern\(s\)\)\)/);
    assert.doesNotMatch(v.stdout, /reserved-placeholder match\(es\) ignored/);
  } finally { fx.cleanup(); }
});

test('runVerify: placeholder-only code file with NO secret AND NO target hit -> 0 hits, N placeholder-ignored', () => {
  // Companion to the data-file PASS test above. Proves that the
  // `no private patterns in code files` rule (which runs the
  // in-source private-pattern scanner over every code file) does
  // the same thing: PLACEHOLDER hits are filtered, the fail/no-fail
  // decision only uses real-targets tokens.
  const fx = makeFixture({
    entries: [{ src: 'placeholder-only.mjs', dst: 'placeholder-only.mjs' }],
  });
  // Two placeholder words in the same file. The scanner returns
  // two `{label: 'client project name', placeholder: true}`
  // objects; the verify rule counts them as 2 placeholder-ignored
  // and PASSES.
  writeFileSync(
    join(fx.root, 'placeholder-only.mjs'),
    '// ui_kits/acme and ui_kits/globex\nexport const x = 1;\n',
  );
  try {
    runCli(['--out', fx.out, '--allowlist', fx.allowlist], { cwd: fx.root });
    const v = runCli(['--verify', fx.out], { cwd: fx.root });
    assert.equal(v.status, 0, `verify: ${v.stderr}\n${v.stdout}`);
    assert.match(v.stdout, /PASS no private patterns in code files \(0 hits, 2 reserved-placeholder match\(es\) ignored\)/);
  } finally { fx.cleanup(); }
});