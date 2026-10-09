// Hermetic tests for the session scrubber. No real operator data ever
// appears in a fixture string. The machine-path rules are derived from
// the CURRENT environment's `os.userInfo().username`, so the tests
// construct each fixture path from that same source and verify the
// placeholder wins on whatever the runtime is.
//
// Targets-file tests use a temp file under os.tmpdir() (node cannot
// open /tmp/... directly on Windows) holding INVENTED client names
// and an INVENTED vault path. Real values never enter source or
// fixtures.
//
// Proves the redaction modes the scrubber must guarantee:
//   (a) a value the operator has set in their environment is redacted verbatim
//   (b) a key-shaped string that was never in the environment is still
//       redacted by pattern
//   (c) operator-identifying text built from `os.userInfo().username`
//       is redacted, both as a path and as a bare token at word boundaries
//   (d) the JSONL-escaped path form is handled (the dominant shape in
//       real transcript data)
//   (e) operator endpoint hosts configured via `*_BASE_URL` env vars
//       are redacted without ever embedding the URL value in source
//   (f) a targets file can supply client tokens and vault rules, and
//       the scrubber works (no crash, no leakage) when the file is
//       absent
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';

import {
  runtimeSecrets, runtimeHosts, scrub, PATTERNS,
  machinePathPatterns, bareUsernamePatterns, loadTargets,
} from './import-sessions.mjs';

// Sanity check: the static patterns we depend on are present. If someone
// edits PATTERNS without keeping the headline sk-/kn-/Bearer/sk-ant-/
// sk-or-v1- shapes this test fails before they can ship the change.
test('PATTERNS covers sk-, kn-, sk-ant-, sk-or-v1-, Bearer, and NAME=value', () => {
  const joined = PATTERNS.map(([re, to]) => [String(re), String(to)].join(' -> ')).join('\n');
  for (const fragment of ['sk-ant-', 'sk-or-v1-', 'sk-', 'kn-', 'Bearer', 'API_KEY', 'SECRET', 'PASSWORD']) {
    assert.ok(joined.includes(fragment), `PATTERNS must cover "${fragment}"`);
  }
});

// (a) Operator-driven: scrub redacts verbatim a value present in the env.
test('scrub redacts a value present in the runtime env (env-driven literals)', () => {
  const secret = 'unshaped-secret-' + 'X'.repeat(40); // 56 chars, no sk-/kn-/Bearer prefix
  const env = { MY_TEST_SECRET: secret, PATH: '/usr/bin', HOME: '/home/tester' };
  const literals = runtimeSecrets(env);
  assert.equal(literals.length, 1, 'runtimeSecrets must pick up *_SECRET vars only');
  assert.equal(literals[0], secret);
  const out = scrub(`the value is ${secret}\n`, literals);
  assert.equal(out.includes(secret), false, 'env-driven literal must be redacted');
  // The replacement marker replaces the literal; the surrounding text survives.
  assert.ok(out.includes('the value is '), 'surrounding text must survive redaction');
});

// (b) Pattern-only: scrub redacts key-shaped values even with no literals.
test('scrub redacts key-shaped values via pattern even when not in env', () => {
  const sk = 'sk-' + 'b'.repeat(40);
  const kn = 'kn-' + 'c'.repeat(40);
  const skAnt = 'sk-ant-api03-' + 'd'.repeat(40);
  const skOr = 'sk-or-v1-' + 'e'.repeat(40);
  const bearer = 'f'.repeat(40);
  const input =
    `Authorization: Bearer ${bearer}\n` +
    `key1=${sk}\n` +
    `key2=${kn}\n` +
    `key3=${skAnt}\n` +
    `key4=${skOr}\n`;
  const out = scrub(input, []); // empty literals list - pattern-only path
  for (const [name, val] of [['sk', sk], ['kn', kn], ['sk-ant', skAnt], ['sk-or-v1', skOr], ['Bearer', bearer]]) {
    assert.equal(out.includes(val), false, `${name}-shaped value must be redacted by pattern`);
  }
});

// Defence in depth: scrub still runs and never throws when both literals and
// patterns are unable to match - this is the contract for unset credentials.
test('scrub works when nothing matches and nothing is in env', () => {
  const out = scrub('plain text with no secrets', []);
  assert.equal(out, 'plain text with no secrets');
});

// ---------------------------------------------------------------------------
// T4r-scrub-targets: machine path, client list, vault rules.
// ---------------------------------------------------------------------------

// (1) Machine paths - both slash directions, both cases, with the path
// remainder preserved so the transcript still reads like a Windows path.
// The path is constructed from the CURRENT environment's username, so
// the test is hermetic - it works on any machine.
test('scrub rewrites the operator home dir as <machine-path> and preserves the rest', () => {
  const user = userInfo().username;
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };

  const fwd = scrub(`see C:/Users/${user}/.claude/projects/x`, [], [], noTargets);
  assert.ok(fwd.includes('<machine-path>/.claude/projects/x'), `forward-slash: ${fwd}`);
  assert.equal(fwd.includes(user), false);

  const back = scrub(`from C:\\Users\\${user}\\foo\\bar`, [], [], noTargets);
  assert.ok(back.includes('<machine-path>/foo'), `backslash: ${back}`);
  assert.equal(back.includes(user), false);

  const lower = scrub(`c:/users/${user.toLowerCase()}/cache`, [], [], noTargets);
  assert.equal(lower, '<machine-path>/cache');
});

// (1b) Machine paths - the JSONL-escaped form. Real transcripts store
// JSON, so a Windows path on disk appears as `C:\\Users\<user>\`
// (each backslash doubled). The single-backslash form is the
// RENDERED form; the scrubber must handle BOTH.
test('scrub rewrites the JSONL-escaped operator home dir as <machine-path>', () => {
  const user = userInfo().username;
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };

  // Build the escaped form: each `\\` in the source becomes a single
  // backslash byte on disk, and the JS literal below is constructed so
  // the test file's string contains the JSONL-escaped shape.
  const escapedFull = `C:\\\\Users\\\\${user}\\\\.claude\\\\projects\\\\x`;
  const out = scrub(escapedFull, [], [], noTargets);
  assert.ok(out.includes('<machine-path>/'), `escaped form: ${out}`);
  assert.equal(out.includes(user), false, 'operator name must be gone');
  assert.ok(out.includes('.claude'), `remainder preserved: ${out}`);

  // Escaped form, no trailing path - still consumed.
  const escapedBare = `C:\\\\Users\\\\${user}\\\\`;
  const outBare = scrub(escapedBare, [], [], noTargets);
  assert.equal(outBare, '<machine-path>/');

  // Case-insensitive: lowercase drive letter + lowercase username.
  const lower = scrub(`c:\\\\users\\\\${user.toLowerCase()}\\\\foo`, [], [], noTargets);
  assert.ok(lower.includes('<machine-path>/foo'), `lower-case: ${lower}`);
  assert.equal(lower.includes(user.toLowerCase()), false);
});

// (1c) Bare operator username - belt-and-braces. The path rule only
// matches a real path-shaped context; this rule catches the username
// ANY time it appears with word boundaries (so in `ls -l` output, in
// prose, in a partial path without a trailing separator, etc.). This
// is the rule that makes the other forms moot for a public release.
test('scrub redacts the bare operator username in any context', () => {
  const user = userInfo().username;
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };

  // The `ls -l` style listing where the operator's name is the owner column.
  const lsLine = scrub(`drwxr-xr-x 1 ${user.toLowerCase()} 197609 0 Oct  3 11:47 .`, [], [], noTargets);
  assert.equal(lsLine.includes(user.toLowerCase()), false, `ls listing: ${lsLine}`);
  assert.ok(lsLine.includes('<user>'), `ls listing replaced: ${lsLine}`);

  // Mixed case.
  const mixed = scrub(`${user} and ${user.toLowerCase()} and ${user.toUpperCase()} all gone`, [], [], noTargets);
  assert.equal(mixed, '<user> and <user> and <user> all gone');

  // Bare token in prose.
  const prose = scrub(`The user ${user} logged in.`, [], [], noTargets);
  assert.equal(prose, 'The user <user> logged in.');

  // Word boundary: `<user>S` is a different word and must survive.
  const notMatch = scrub(`${user}S and pre${user.toLowerCase()} stay`, [], [], noTargets);
  assert.equal(notMatch, `${user}S and pre${user.toLowerCase()} stay`);
});

// Negative cases for the path rule - things that LOOK like paths but
// aren't. The bare-username catch-all (belt-and-braces) still scrubs
// the operator's name when the path suffix is missing.
test('scrub does not rewrite partial operator strings that lack the path suffix', () => {
  const user = userInfo().username;
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };

  // No trailing slash after the username: the PATH rule does not
  // match, but the bare-username catch-all still scrubs it. This is
  // the load-bearing behaviour for a public release: a leftover
  // username anywhere is unacceptable, path or not.
  const bare = scrub(`C:/Users/${user}`, [], [], noTargets);
  assert.equal(bare.includes(user), false, `operator name must be scrubbed: ${bare}`);
  assert.ok(bare.includes('<user>'), `must be replaced with <user>: ${bare}`);
  // A different username is not consumed (the rule is operator-specific).
  const otherUser = scrub('C:/Users/SomeoneElse/foo', [], [], noTargets);
  assert.ok(otherUser.includes('SomeoneElse'), `other user must survive: ${otherUser}`);
});

// (2) Email addresses - including the plus-tag and subdomain variants the
// local transcripts use in tool examples. Both fixture addresses use
// reserved documentation domains so the test source holds no real
// (non-reserved) email.
test('scrub replaces email addresses with <email>', () => {
  const out = scrub('contact me at foo.bar+tag@example.com or short-name@example.org', []);
  assert.equal(out, 'contact me at <email> or <email>');
  assert.equal(out.includes('@'), false);
});

// (3) Client project names - supplied through the targets file, NOT
// hardcoded. The test builds an INVENTED targets object and verifies
// the scrubber redacts the corresponding tokens. Word boundaries keep
// the trailing punctuation so a hyphen, dot, or whitespace after the
// name survives intact.
test('with targets file: client-shaped tokens are redacted to <client>', () => {
  // The fixture names are NOT in the export-public.mjs static
  // baseline pattern, so the test source does not self-match the
  // verify rule.
  const targets = {
    loaded: true,
    sourcePath: '<inline>',
    paths: [],
    tokens: [
      { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
      { pattern: '\\bBarInc\\b', replace: '<client>', flags: 'gi' },
    ],
  };
  const dash = scrub('see FooCorp-151 for context', [], [], targets);
  assert.equal(dash, 'see <client>-151 for context');

  const sub = scrub('visit barinc.example.io for the dns', [], [], targets);
  assert.equal(sub, 'visit <client>.example.io for the dns');

  const upper = scrub('BarInc v2 launched', [], [], targets);
  assert.equal(upper, '<client> v2 launched');

  const mixed = scrub('FooCorp and barinc and FOOCORP', [], [], targets);
  assert.equal(mixed, '<client> and <client> and <client>');
});

// (3b) Without a targets file: client-shaped tokens must SURVIVE and
// the scrubber must not crash. This is the load-bearing contract for
// a public release that ships without operator-specific data.
test('without targets file: client-shaped tokens are NOT redacted and nothing crashes', () => {
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };
  const out = scrub('see FooCorp-151 and barinc.test in scope', [], [], noTargets);
  assert.equal(out, 'see FooCorp-151 and barinc.test in scope');
});

// Negative cases for the client token rule - substrings that look
// like a client name but should NOT be redacted (the `\b` boundary
// protects against this).
test('scrub does NOT redact substrings of larger words (token rule uses word boundaries)', () => {
  const targets = {
    loaded: true,
    sourcePath: '<inline>',
    paths: [],
    tokens: [
      { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
    ],
  };
  // FooCorps (different word) survives.
  assert.equal(scrub('FooCorps grow in summer', [], [], targets), 'FooCorps grow in summer');
  // preFooCorp is not the same word.
  assert.equal(scrub('preFooCorp rule', [], [], targets), 'preFooCorp rule');
  // preHost is not the same word as the configured JEV host: when
  // the JEV_HOST env var is unset (the test's default), the host
  // rule does not fire and the fixture survives verbatim.
  assert.equal(scrub('preHost.example rule', [], [], targets), 'preHost.example rule');
});

// (4) Vault rules - driven by the targets file, NOT hardcoded. The
// vault root path -> <repo> and the bare vault name -> <vault>.
// (4a) Vault root path -> <repo>.
test('vault root path from targets file is redacted to <repo>', () => {
  const targets = {
    loaded: true,
    sourcePath: '<inline>',
    paths: [{ from: 'C:/tmp/MySecretVault', to: '<repo>' }],
    tokens: [],
  };
  const out = scrub('path is C:/tmp/MySecretVault/foo.jsonl', [], [], targets);
  assert.equal(out, 'path is <repo>/foo.jsonl');
});

// (4b) Bare vault name -> <vault>.
test('bare vault name from targets file is redacted to <vault>', () => {
  const targets = {
    loaded: true,
    sourcePath: '<inline>',
    paths: [{ from: 'MySecretVault', to: '<vault>' }],
    tokens: [],
  };
  const out = scrub('MySecretVault in scope', [], [], targets);
  assert.equal(out, '<vault> in scope');
});

// (4c) Ordering: when both the path and the bare name are listed in
// the targets file, the more specific (path) rule wins. The path rule
// is placed first in the `paths` array; once it consumes
// `C:/tmp/MySecretVault`, the bare-name rule has nothing to match.
test('vault path is redacted before the bare name (more specific rule wins)', () => {
  const targets = {
    loaded: true,
    sourcePath: '<inline>',
    paths: [
      { from: 'C:/tmp/MySecretVault', to: '<repo>' },
      { from: 'MySecretVault', to: '<vault>' },
    ],
    tokens: [],
  };
  const out = scrub('see C:/tmp/MySecretVault/foo', [], [], targets);
  assert.equal(out, 'see <repo>/foo');
  assert.equal(out.includes('MySecretVault'), false);
});

// (5) Operator endpoints - JEV host + runtime host discovery.
// (5a) the configured JEV host -> <jev-host>, even when it appears
// inside a URL. The host is supplied via JEV_HOST at scrub time so
// the source file does not embed a real hostname.
test('scrub rewrites the configured JEV host as <jev-host>', () => {
  const JEV = 'configured-jev-host.example.test';
  const prev = process.env.JEV_HOST; process.env.JEV_HOST = JEV;
  try {
    const out = scrub(`POST https://${JEV}/v1/systemone for scoring`, []);
    assert.equal(out, 'POST https://<jev-host>/v1/systemone for scoring');
    assert.equal(out.includes(JEV), false);

    // A different host (not the JEV host) is not rewritten.
    const neg = scrub('other-host.example test', []);
    assert.ok(neg.includes('other-host.example'), `neg: ${neg}`);
  } finally { if (prev === undefined) delete process.env.JEV_HOST; else process.env.JEV_HOST = prev; }
});

// (5b) runtimeHosts() pulls the host portion (only the host) of every
// *_BASE_URL env var, skipping unparseable values and the configured
// JEV host (which is handled by PATTERNS, not by the runtime pass).
test('runtimeHosts extracts only the host portion of *_BASE_URL env vars and skips the configured JEV host', () => {
  const JEV = 'configured-jev-host.example.test';
  const env = {
    JEV_HOST: JEV,
    ANTHROPIC_BASE_URL: 'http://192.0.2.69:20128',
    JEV_BASE_URL: `https://${JEV}/v1/systemone`,
    JEV_BASE_URL2: 'https://openrouter.ai/api/alpha/decisions',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    NOT_A_URL: 'oops',
    EMPTY_URL: '',
    PATH: '/usr/bin', // not a *_BASE_URL
  };
  const hosts = runtimeHosts(env);
  assert.ok(hosts.includes('192.0.2.69:20128'), 'must extract private LLM host');
  assert.ok(hosts.includes('api.openai.com'), 'must extract OpenAI host');
  assert.ok(hosts.includes('openrouter.ai'), 'must extract OpenRouter host');
  assert.equal(hosts.includes(JEV), false, 'configured JEV host is handled by PATTERNS, not runtime');
  assert.equal(hosts.length, 3, `unexpected hosts: ${JSON.stringify(hosts)}`);
});

// (5c) End-to-end: scrub redacts a runtime-discovered host without ever
// receiving the URL value as a string in source.
test('scrub redacts runtime endpoint hosts without embedding the URL', () => {
  const env = { ANTHROPIC_BASE_URL: 'http://192.0.2.69:20128' };
  const hosts = runtimeHosts(env);
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };
  const out = scrub('POST http://192.0.2.69:20128/v1/messages here', [], hosts, noTargets);
  assert.equal(out, 'POST http://<endpoint-host>/v1/messages here');
  assert.equal(out.includes('192.0.2'), false);
});

// (6) Dynamic helpers - the patterns are derived from the runtime
// username, never from a hardcoded literal.
test('machinePathPatterns and bareUsernamePatterns are derived from os.userInfo()', () => {
  const user = userInfo().username;
  const m = machinePathPatterns();
  const b = bareUsernamePatterns();
  // The patterns are RegExp objects - check by toString().
  const mStr = m.map(([re, to]) => [String(re), String(to)].join(' -> ')).join('\n');
  const bStr = b.map(([re, to]) => [String(re), String(to)].join(' -> ')).join('\n');
  assert.ok(mStr.includes(user), `machine-path patterns must mention the runtime username: ${mStr}`);
  assert.ok(bStr.includes(user), `bare-username pattern must mention the runtime username: ${bStr}`);
  assert.equal(mStr.includes('<machine-path>'), true);
  assert.equal(bStr.includes('<user>'), true);
});

// (7) loadTargets - the loader handles the three real cases the
// operator encounters.
test('loadTargets: missing file returns empty targets (no crash)', () => {
  const env = { SCRUB_TARGETS: 'C:/this/does/not/exist/anywhere.json' };
  const t = loadTargets({ env, repoRoot: 'C:/also/missing' });
  assert.equal(t.loaded, false);
  assert.deepEqual(t.paths, []);
  assert.deepEqual(t.tokens, []);
});

test('loadTargets: present file is parsed and shape-validated', () => {
  const root = join(tmpdir(), 'fleet-scrub-targets-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
  try {
    const f = join(root, 'targets.json');
    writeFileSync(f, JSON.stringify({
      paths: [
        { from: 'C:/tmp/VaultFooCorp', to: '<repo>' },
        { from: 'VaultFooCorp', to: '<vault>' },
      ],
      tokens: [
        { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
      ],
    }), 'utf8');
    const env = { SCRUB_TARGETS: f };
    const t = loadTargets({ env, repoRoot: '<unused>' });
    assert.equal(t.loaded, true);
    assert.equal(t.paths.length, 2);
    assert.equal(t.tokens.length, 1);
    assert.equal(t.paths[0].from, 'C:/tmp/VaultFooCorp');
    assert.equal(t.tokens[0].pattern, '\\bFooCorp\\b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTargets: malformed file throws (operator sees the breakage)', () => {
  const root = join(tmpdir(), 'fleet-scrub-targets-bad-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
  try {
    const f = join(root, 'targets.json');
    writeFileSync(f, 'not json', 'utf8');
    assert.throws(() => loadTargets({ env: { SCRUB_TARGETS: f }, repoRoot: '<unused>' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Post-strip invariant: scrub must keep working when nothing is in the
// env (no literals, no hosts) and no targets file is supplied. The
// static PATTERNS rules and the env-derived machine-path rules still
// apply.
test('scrub works when runtime env is empty and no targets - patterns still fire', () => {
  const user = userInfo().username;
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };
  const JEV = 'configured-jev-host.example.test';
  const prev = process.env.JEV_HOST; process.env.JEV_HOST = JEV;
  try {
    const out = scrub(
      `C:/Users/${user}/foo and FooCorp-151 and ${JEV}`,
      runtimeSecrets({}),
      runtimeHosts({}),
      noTargets,
    );
    // The path rule fires on the runtime username; the static JEV-host
    // rule fires on the configured host; the invented `FooCorp-151`
    // survives because no targets file is loaded (the client list is
    // operator-specific).
    assert.equal(out, '<machine-path>/foo and FooCorp-151 and <jev-host>');
    // The literals/hosts from an empty env are []; PATTERNS still fire.
    assert.deepEqual(runtimeSecrets({}), []);
    assert.deepEqual(runtimeHosts({}), []);
  } finally { if (prev === undefined) delete process.env.JEV_HOST; else process.env.JEV_HOST = prev; }
});

// Ordering invariant: a secret substring inside a machine path must be
// redacted before the path rule rewrites the surrounding text. Proves
// the load-bearing ordering described in the module comment.
test('ordering: secret inside a machine path is fully redacted before the path rule fires', () => {
  const user = userInfo().username;
  const secret = 'op-secret-' + 'Q'.repeat(30); // 40 chars, > 8
  const env = { MY_API_KEY: secret };
  const noTargets = { loaded: false, sourcePath: '<none>', paths: [], tokens: [] };
  const input = `path is C:/Users/${user}/${secret}.jsonl in the vault`;
  const out = scrub(input, runtimeSecrets(env), runtimeHosts({}), noTargets);
  assert.equal(out.includes(secret), false, 'secret must be redacted');
  // The literal is fully consumed; what survives around it is fine.
  assert.ok(out.includes('<machine-path>/'), `path prefix rewritten: ${out}`);
  assert.equal(out.includes(user), false);
});

// ---------------------------------------------------------------------------
// End-to-end fixture: one tmpdir, one .jsonl containing every shape
// the new rules must cover, plus a targets file with INVENTED
// clients/vault - prove the scrubbed output has no operator name, no
// email shape, no client token, no configured JEV host, no vault name
// or path, and no private LLM endpoint.
// ---------------------------------------------------------------------------
test('integration: scrubbing a fixture containing every shape leaks nothing', () => {
  // (a) build a tmpdir fixture under os.tmpdir() (node cannot open /tmp).
  const root = join(tmpdir(), 'fleet-import-sessions-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
  // Build the configured JEV host from the env so the source holds no
  // real hostname. The integration test plants this exact host in the
  // fixture and asserts the scrubber rewrites it.
  const JEV = 'configured-jev-host.example.test';
  const PREV_JEV = process.env.JEV_HOST; process.env.JEV_HOST = JEV;
  try {
    // Minimal env with a known *_BASE_URL so runtimeHosts is exercised.
    const env = { ANTHROPIC_BASE_URL: 'http://192.0.2.69:20128' };
    // Construct every operator-specific fixture value from the runtime
    // environment, NOT from any hardcoded literal. The test is
    // hermetic: it works on any machine.
    const user = userInfo().username;
    const tmpTargets = join(root, 'targets.json');
    writeFileSync(tmpTargets, JSON.stringify({
      paths: [
        { from: 'C:/tmp/MySecretVault', to: '<repo>' },
        { from: 'MySecretVault', to: '<vault>' },
      ],
      tokens: [
        { pattern: '\\bFooCorp\\b', replace: '<client>', flags: 'gi' },
        { pattern: '\\bBarInc\\b', replace: '<client>', flags: 'gi' },
      ],
    }), 'utf8');
    const targets = loadTargets({ env: { SCRUB_TARGETS: tmpTargets }, repoRoot: '<unused>' });
    assert.equal(targets.loaded, true);
    const sessionId = 'test-' + Math.random().toString(36).slice(2, 10);
    const fixturePath = join(root, sessionId + '.jsonl');
    // Every shape the rules must redact, mixed into one transcript line.
    // The path is built from the runtime username; the JEV host is
    // built from the env var; the LLM endpoint is a reserved-RFC IP.
    // The escaped form uses literal double backslashes (each `\\` in
    // this JS source becomes two backslash bytes on disk - the JSONL
    // form).
    const fixture =
      `{"type":"user","message":{"content":"paths: C:/Users/${user}/.claude/projects/x and C:/Users/${user}/foo and C:\\\\Users\\\\${user}\\\\.claude; ` +
      `emails: foo@example.com and bar+tag@FooCorp-151.example.com; ` +
      `clients: FooCorp-151 barinc.example.io BarInc v2; ` +
      `vault: C:/tmp/MySecretVault/inside and MySecretVault elsewhere; ` +
      `hosts: https://${JEV}/v1 and POST http://192.0.2.69:20128/v1; ` +
      `bare: drwxr-xr-x 1 ${user.toLowerCase()} 197609 0 Oct  3 11:47 .; ` +
      `negative: not-the-jev.example FooCorps preBarInc C:/Users/Other/foo ${user}S stays"}}`;
    writeFileSync(fixturePath, fixture, 'utf8');

    // (b) exercise the actual scrubber the same way the CLI does: import
    // the module, run `scrub` over the fixture text, and also exercise
    // `runtimeHosts` end-to-end against the env.
    const literals = runtimeSecrets({}); // empty - no real env
    const hosts = runtimeHosts(env);
    const scrubbed = scrub(readFileSync(fixturePath, 'utf8'), literals, hosts, targets);
    writeFileSync(fixturePath + '.scrubbed', scrubbed, 'utf8');

    // (c) regression assertions.
    // The /\b<user>\b/gi check catches every casing of the operator
    // name at word boundaries, matching the bare-username rule's
    // contract: a leftover username anywhere is unacceptable.
    // `<user>S` is a different word and is allowed to survive.
    const reUser = new RegExp(`\\b${user}\\b`, 'i');
    assert.equal(reUser.test(scrubbed), false, 'no operator name at word boundary may remain');
    assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(scrubbed), false,
      'no @-shaped address may remain');
    assert.equal(
      /\b(?:FooCorp|BarInc)\b/i.test(scrubbed),
      false,
      'no client token may remain'
    );
    const reJev = new RegExp(`\\b${JEV.replace(/\./g, '\\.')}\\b`);
    assert.equal(reJev.test(scrubbed), false, 'no configured JEV host may remain');
    assert.equal(scrubbed.includes('192.0.2.69'), false, 'no reserved LLM endpoint may remain');
    assert.equal(scrubbed.includes('MySecretVault'), false, 'no bare vault name may remain');
    assert.equal(scrubbed.includes('C:/tmp/MySecretVault'), false, 'no vault root path may remain');

    // (d) positive: placeholders did land where expected.
    assert.ok(scrubbed.includes('<machine-path>/'), 'machine path placeholder present');
    assert.ok(scrubbed.includes('<user>'), 'bare-username placeholder present');
    assert.ok(scrubbed.includes('<email>'), 'email placeholder present');
    assert.ok(scrubbed.includes('<client>'), 'client placeholder present');
    assert.ok(scrubbed.includes('<jev-host>'), 'jev host placeholder present');
    assert.ok(scrubbed.includes('<endpoint-host>'), 'runtime endpoint host placeholder present');
    assert.ok(scrubbed.includes('<repo>'), 'vault root placeholder present');
    assert.ok(scrubbed.includes('<vault>'), 'bare vault name placeholder present');

    // (e) negative shapes must survive (not a JEV host, not a client
    // word, not an operator path, not an email).
    assert.ok(scrubbed.includes('not-the-jev.example'), 'non-JEV host must survive');
    assert.ok(scrubbed.includes('FooCorps'), 'FooCorps (not FooCorp) must survive');
    assert.ok(scrubbed.includes('preBarInc'), 'preBarInc (not BarInc) must survive');
    assert.ok(scrubbed.includes('C:/Users/Other/foo'), 'other user path must survive');
    assert.ok(scrubbed.includes(`${user}S`), `${user}S (different word) must survive`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
