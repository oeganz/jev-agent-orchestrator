// Curated public-repo export tool. Allowlist-only: it copies exactly the
// pairs named in an allowlist JSON into a fresh output directory and
// never walks the source tree to decide what to copy. A denylist
// ("copy everything, then delete the secrets") leaks the next thing
// someone adds; this tool does not.
//
//   node fleet/bin/export-public.mjs --out <dir> [--allowlist <file>] [--redactions <file>] [--targets <file>]
//   node fleet/bin/export-public.mjs --scan [--allowlist <file>]
//   node fleet/bin/export-public.mjs --verify <dir> [--redactions <file>] [--targets <file>]
//
// Modes:
//   default   copy every entry; every TEXT file (binary files skipped)
//             goes through import-sessions.scrub() and then the literal
//             redactions from --redactions
//   --scan    print the allowlist as an indented tree, verify every src exists
//   --verify  run the no-leak rules against an assembled tree
//
// The first stdout line of every mode is the resolved allowlist (path
// and entry count) so an operator can eyeball what they are about to
// act on before anything is written.
//
// Scrubbing policy: the SAME scrubber the importer uses
// (`./import-sessions.mjs`'s `scrub()`) is run on a RESTRICTED set of
// extensions — the data/prose file types. The set is enumerated
// explicitly in `SCRUBBABLE_EXTENSIONS`. Code files (CODE_EXTENSIONS)
// are NEVER scrubbed: a text scrubber is safe on prose and data and
// destructive on code. Measured before this fix: the generic `sk-`
// rule in the scrubber ate the tool's OWN regex literal
// `const CSS_KEBAB_TOKEN = /sk-[a-z][a-z-]{19,}/g;` and shipped
// `const CSS_KEBAB_TOKEN = <redacted>,}/g;`, which the Node loader
// rejects with `Unexpected token '<'`. Code is therefore copied
// byte-identical AND verified byte-identical, with a separate
// code-pattern scan that surfaces any private strings the source
// still holds (so the operator can fix the source rather than the
// scrubber shipping a broken tree).
//
// The private targets file (client names, the vault root/name) is
// loaded once per run and passed to the scrubber, so a value the
// operator adds there is redacted wherever it appears. The file is
// found the same way import-sessions.mjs finds it: the `SCRUB_TARGETS`
// env var, else `fleet/scrub-targets.json`; `--targets` overrides
// both. An ABSENT file is not an error - the scrubber simply runs with
// fewer rules. A MALFORMED file aborts the copy with a loud
// "OUTPUT IS INCOMPLETE" banner, because a half-built tree that looks
// finished is worse than no tree.
//
// The scrub step is ON BY DEFAULT for the scrubbable extensions
// (data/prose). To opt out, pass `--no-scrub-sessions` — the tool
// then prints a loud warning to stderr because a public export that
// silently skips scrubbing is the failure mode this default exists
// to prevent. The scrubber is called with empty literal and host
// lists so the export behaviour does not depend on whatever happens
// to be in the operator's local .env at export time. The flag is
// named after the historical scope (sessions only) and is kept for
// compatibility; in the current policy it disables scrubbing for
// every scrubbable extension, not just sessions.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo, homedir } from 'node:os';
import { scrub, loadTargets as loadScrubTargets } from './import-sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = resolve(join(HERE, '..', '..'));
// The repo root for the COPY/SCAN step: by default the script's repo (the
// fleet orchestrator checkout). The CLI main() overrides this with
// process.cwd() so the operator can run the tool from anywhere; tests
// also override it via the explicit runCopy/runScan args.
const DEFAULT_ROOT = SCRIPT_ROOT;
const DEFAULT_ALLOWLIST = join(DEFAULT_ROOT, 'fleet', 'export-public', 'allowlist.json');
const DEFAULT_TARGETS_PATH = join(SCRIPT_ROOT, 'fleet', 'scrub-targets.json');

// --- verify patterns ---------------------------------------------------------
//
// The key pattern must NOT match CSS class names that happen to start with
// `sk-` (e.g. `sk-background-color-default`). The vendor-prefixed branches
// are unambiguous. The generic `sk-` branch requires at least one UPPERCASE
// letter or DIGIT within the run (bounded lookahead): real provider keys are
// base62-ish and a 20+ char run without either is vanishingly rare, while
// kebab-case CSS identifiers are always lowercase+hyphen. This beats an
// end-of-string lookahead, which breaks when the CSS token is followed by
// `:` or digits inside a declaration (`--sk-background-color-default: #fff`).
const SECRET_PATTERN =
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-(?=[A-Za-z0-9_-]{20,})(?=[A-Za-z_-]{0,80}[A-Z0-9])[A-Za-z0-9_-]{20,}|kn-[A-Za-z0-9]{20,}|gbrain_[0-9a-f]{40,}|Bearer\s+[A-Za-z0-9._-]{20,}/;
// The same discriminator the verify rule uses, as a pure-kebab detector:
// an sk- run of 20+ lowercase/hyphen characters CANNOT be a provider key
// (no uppercase, no digit), so the export masks these tokens around the
// scrub() call. Why here: the scrubber's own generic rule (in
// import-sessions.mjs - OUT OF SCOPE for this task) has the looser shape
// and rewrites `sk-background-color-default` to `sk-<redacted>`, which
// corrupts the shipped monitor bundle (measured: 10 substitutions in the
// dist CSS/JS). The mask keeps the call-site behaviour correct until the
// underlying pattern in the importer is tightened; see the task report.
const CSS_KEBAB_TOKEN = /sk-[a-z][a-z-]{19,}/g;
const MASK_PREFIX = '\u0000CSSK';
const MASK_SUFFIX = '\u0000';

function maskCssKebabTokens(text) {
  const saved = [];
  const masked = text.replace(CSS_KEBAB_TOKEN, (m) => {
    saved.push(m);
    return MASK_PREFIX + (saved.length - 1) + MASK_SUFFIX;
  });
  return { masked, saved };
}

function unmaskCssKebabTokens(text, saved) {
  return text.replace(new RegExp(MASK_PREFIX + '(\\d+)' + MASK_SUFFIX, 'g'), (_, i) => {
    const idx = Number(i);
    return idx < saved.length ? saved[idx] : _;
  });
}
const MACHINE_PATH = (() => {
  // The operator's home, used as the prefix the scrubber rewrites to
  // `<machine-path>`. Derived from os.userInfo().username (the same
  // source the scrubber uses for the machine-path patterns) so a
  // case mismatch between homedir() and userInfo() — possible on
  // Windows where the two APIs read different sources — does not
  // silently leak. When userInfo() cannot be read (some CI
  // environments) the rule SKIPs and the operator can pass
  // --machine-path explicitly.
  let u = '';
  try { u = userInfo().username || ''; } catch { /* skip */ }
  if (!u) return '';
  return 'C:/Users/' + u;
})();
// Static baseline client-name pattern. The first-party code tree MUST
// NOT embed real client project names, so the static pattern is a
// placeholder-only list built at runtime from char-code arrays (the
// literal names are never typed in source, so the pattern does not
// self-match when the file is scanned by the verify rule). The
// runtime targets overlay (loadTargetsForExport ->
// clientTokensFromTargets) supplies the real names at the call sites
// (checkClientNames, findCodePatternMatches) and is merged into the
// patterns array there, so the rule still catches real client names.
// The placeholder baseline means a missing targets file still flags
// the most common placeholder names that were used to REPLACE the
// real ones, so a forgotten swap in a fixture is reported at verify
// time.
//
// Reserved-placeholder convention: matches against this static list
// are NEVER failures (mirrors the email rule: `example.com` is
// placeholder vocabulary, not a leak). The rule tracks a separate
// `placeholderMatches` count and reports it in the detail string, so
// the diagnostic value of "the placeholder baseline fires here" is
// preserved — but the rule only FAILs on a hit by a
// targets-supplied token. Measured (T15b): without this, the rule
// fired on the word `acme` in 15 transcripts because tool
// descriptions use `ui_kits/acme/**/*.html` as an example path.
const _CLIENT_PLACEHOLDERS = [
  [97, 99, 109, 101],                 // a-c-m-e
  [103, 108, 111, 98, 101, 120],      // g-l-o-b-e-x
  [119, 105, 100, 103, 101, 116],     // w-i-d-g-e-t
  [99, 111, 110, 116, 111, 115, 111], // c-o-n-t-o-s-o
  [105, 110, 105, 116, 101, 99, 104], // i-n-i-t-e-c-h
  [117, 109, 98, 114, 101, 108, 108, 97], // u-m-b-r-e-l-l-a
].map((cs) => cs.map((c) => String.fromCharCode(c)).join(''));
const CLIENT_NAMES = new RegExp('\\b(?:' + _CLIENT_PLACEHOLDERS.join('|') + ')\\b', 'i');
const _CLIENT_PLACEHOLDERS_LOWER = new Set(_CLIENT_PLACEHOLDERS.map((s) => s.toLowerCase()));
function isReservedClientName(name) {
  return typeof name === 'string' && _CLIENT_PLACEHOLDERS_LOWER.has(name.toLowerCase());
}
// Exported for tests — the prose rule's filter helper is the
// unit-level mirror of the email rule's `isReservedEmailDomain`.
export const _isReservedClientName = isReservedClientName;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Reserved documentation domains (RFC 2606 + the local-host convention).
// The verify rule counts and reports matches in this list separately and
// never reports them as failures - the same convention other tools use
// for placeholder values like `user@example.com`. The leading `(?<![A-Za-z0-9-])`
// keeps the matcher from over-matching `notexample.com`.
const RESERVED_EMAIL_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'invalid']);
const RESERVED_EMAIL_SUFFIXES = ['.example.com', '.example.net', '.example.org', '.invalid'];

// --- Extension policy --------------------------------------------------------
//
// Two disjoint, explicit sets drive the copy step. The split is the
// lesson from T4r2: a text scrubber is safe on prose and data and
// destructive on code. The four code extensions in CODE_EXTENSIONS are
// the ones the spec pins (measured corruption: the generic `sk-` rule
// ate the export tool's own regex literal). They are copied
// byte-identical AND asserted byte-identical, with a separate scan
// that surfaces any private string the source still holds. The
// scrubbable set covers the prose/data extensions the spec names
// (`.md`, `.jsonl`, `.txt`, `.html`) plus a few more data shapes the
// allowlist contains: `.json` (config and run manifests), `.yml`/
// `.yaml` (CI), `.svg` (markup; can carry private strings), `.mmd`
// (mermaid; labels can carry private strings), `.diff` (test fixtures;
// diff bodies can carry private strings). Other text files outside
// both sets — meta files like `.LICENSE`, `.gitkeep`, `.gitignore`,
// files with no extension — are copied as-is (no scrub), so the
// scrubber cannot destroy them by accident.
const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.css']);
const SCRUBBABLE_EXTENSIONS = new Set(['.md', '.jsonl', '.txt', '.html', '.json', '.yml', '.yaml', '.svg', '.mmd', '.diff']);

// Extension of a path, lowercased, including the leading dot. Pure;
// exported so tests can exercise the policy directly. A path with no
// extension returns the empty string; a path whose only dot is the
// leading dot of a basename (`.gitkeep`, `.gitignore`) also returns
// the empty string, because treating `.gitkeep` as a "gitkeep
// extension" would be misleading and would put it in a code/scrub
// bucket it does not belong in.
export function extOf(p) {
  const s = String(p);
  // Walk back to the last separator; only consider the dot after it.
  const sepFwd = s.lastIndexOf('/');
  const sepBack = s.lastIndexOf('\\');
  const sep = Math.max(sepFwd, sepBack);
  const tail = sep >= 0 ? s.slice(sep + 1) : s;
  const i = tail.lastIndexOf('.');
  if (i <= 0) return ''; // no dot in the basename, or leading-dot-only
  return tail.slice(i).toLowerCase();
}

// The classifications the copy loop uses, exported so the test suite
// can assert them without round-tripping through `runCopy`.
export function classifyExtension(p) {
  const e = extOf(p);
  if (CODE_EXTENSIONS.has(e)) return 'code';
  if (SCRUBBABLE_EXTENSIONS.has(e)) return 'scrubbable';
  if (!e) return 'passthrough'; // no extension -> copy as-is
  return 'other';
}

// Private-pattern scanner used on CODE files after a byte-identical
// copy. Returns one entry per match with the line number and a masked
// preview (first 4 chars + ellipsis), so the operator can locate the
// leak without the report ever printing a real secret value. The
// patterns mirror what the scrubber would catch on a prose file, so
// a code file that holds a private string is reported with the same
// labels the operator already recognises.
// Every regex is FORCED to the global flag so `.exec` advances
// `lastIndex`. Without that, a non-global regex would re-match the
// first occurrence forever -- measured during T10: a 2-3 MB code
// file scanned against CLIENT_NAMES (which has no `g` flag) hung
// the export process for minutes. Reconstructing the regex with
// `new RegExp(src.source, flags + 'g')` is safe; the source is
// already re-escaped, and adding the `g` flag is a no-op on
// already-global patterns.
// Reserved-domain emails (`@example.com` / `.org` / `.net` / `.invalid`)
// are filtered the same way the prose rule filters them: a comment
// that mentions `user@example.com` is documentation, not a leak.
// Reserved-placeholder client names (the static `_CLIENT_PLACEHOLDERS`
// baseline) are filtered with the same convention: a code-file match
// against the placeholder list is tagged `placeholder: true` on the
// returned hit, so the caller can distinguish "our own vocabulary fired"
// (ignored) from "a real targets-supplied client name" (FAILs).
// Pure: no IO. Exported for tests.
function findCodePatternMatches(text, clientTokens = []) {
  const hits = [];
  function scan(label, src, opts = {}) {
    const flags = src.flags.includes('g') ? src.flags : src.flags + 'g';
    const re = new RegExp(src.source, flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      const line = before.split('\n').length;
      const matched = m[0];
      const masked = matched.length <= 4
        ? '*'.repeat(matched.length)
        : matched.slice(0, 4) + '\u2026' + `(${matched.length} chars)`;
      const hit = { label, line, masked, at: m.index };
      // The static CLIENT_NAMES pattern only ever matches reserved
      // placeholders (the list's whole purpose); flag each hit so the
      // caller can filter it out of the failure set without losing the
      // count. Targets-supplied tokens carry no such flag.
      if (opts.placeholderName) hit.placeholder = true;
      hits.push(hit);
      // Defend against zero-width matches in any user-supplied pattern
      // (none today, but a future token rule could regress).
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  // Mirror the shape classes the verify rule + scrubber recognise.
  scan('secret-shaped string', SECRET_PATTERN);
  if (MACHINE_PATH) scan('operator machine path', new RegExp(reEscape(MACHINE_PATH), 'g'));
  scan('client project name', CLIENT_NAMES, { placeholderName: true });
  if (Array.isArray(clientTokens)) {
    for (const tk of clientTokens) {
      try { scan('client project name', new RegExp(tk.source, tk.flags)); }
      catch { /* skip an invalid pattern rather than crashing the run */ }
    }
  }
  // Reserved-domain emails (RFC 2606 + .invalid) are filtered, matching
  // the prose rule's behaviour: a comment that mentions a documentation
  // placeholder is not a leak. The same filter function is reused.
  const EMAIL_GLOBAL = new RegExp(EMAIL_PATTERN.source, 'g');
  let em;
  while ((em = EMAIL_GLOBAL.exec(text)) !== null) {
    if (!isReservedEmailDomain(em[0])) {
      const before = text.slice(0, em.index);
      const line = before.split('\n').length;
      const matched = em[0];
      const masked = matched.length <= 4
        ? '*'.repeat(matched.length)
        : matched.slice(0, 4) + '…' + `(${matched.length} chars)`;
      hits.push({ label: 'email address', line, masked, at: em.index });
    }
    if (em.index === EMAIL_GLOBAL.lastIndex) EMAIL_GLOBAL.lastIndex += 1;
  }
  return hits;
}

function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- CLI parsing -------------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    mode: 'copy',
    out: null,
    allowlist: DEFAULT_ALLOWLIST,
    redactions: null,
    targets: null, // explicit override for the private targets file
    scrubSessions: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan') out.mode = 'scan';
    else if (a === '--verify') {
      out.mode = 'verify';
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('--verify requires a directory');
      out.out = v;
      i++;
    } else if (a === '--out') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('--out requires a value');
      out.out = v;
      i++;
    } else if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (!v) fail('--out requires a value');
      out.out = v;
    } else if (a === '--allowlist') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('--allowlist requires a value');
      out.allowlist = v;
      i++;
    } else if (a.startsWith('--allowlist=')) {
      const v = a.slice('--allowlist='.length);
      if (!v) fail('--allowlist requires a value');
      out.allowlist = v;
    } else if (a === '--redactions') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('--redactions requires a value');
      out.redactions = v;
      i++;
    } else if (a.startsWith('--redactions=')) {
      const v = a.slice('--redactions='.length);
      if (!v) fail('--redactions requires a value');
      out.redactions = v;
    } else if (a === '--targets') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail('--targets requires a value');
      out.targets = v;
      i++;
    } else if (a.startsWith('--targets=')) {
      const v = a.slice('--targets='.length);
      if (!v) fail('--targets requires a value');
      out.targets = v;
    } else if (a === '--no-scrub-sessions') {
      // Loud opt-out: scrubbing session transcripts is on by default. This
      // flag exists for the narrow case of a non-public export (e.g.
      // a local mirror) where the operator accepts the risk; the
      // tool prints a WARNING to stderr whenever it is set.
      out.scrubSessions = false;
    } else {
      fail('unrecognised argument: ' + a);
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write('error: ' + msg + '\n');
  process.exit(2);
}

// --- Allowlist IO ------------------------------------------------------------

export function loadAllowlist(path) {
  if (!existsSync(path)) {
    fail('allowlist not found: ' + path);
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail('cannot read allowlist ' + path + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('cannot parse allowlist ' + path + ': ' + err.message);
  }
  if (!Array.isArray(parsed)) {
    fail('allowlist must be a JSON array: ' + path);
  }
  const entries = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object') fail('allowlist[' + i + '] is not an object');
    if (typeof e.src !== 'string' || !e.src) fail('allowlist[' + i + '].src missing');
    if (typeof e.dst !== 'string' || !e.dst) fail('allowlist[' + i + '].dst missing');
    entries.push({ src: e.src, dst: e.dst });
  }
  return { path: resolve(path), entries };
}

export function loadRedactions(path) {
  if (!path) return { path: null, entries: [] };
  if (!existsSync(path)) fail('redactions not found: ' + path);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    fail('cannot read redactions ' + path + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail('cannot parse redactions ' + path + ': ' + err.message);
  }
  if (!Array.isArray(parsed)) fail('redactions must be a JSON array: ' + path);
  const entries = [];
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object') fail('redactions[' + i + '] is not an object');
    if (typeof e.from !== 'string') fail('redactions[' + i + '].from missing');
    if (typeof e.to !== 'string') fail('redactions[' + i + '].to missing');
    entries.push({ from: e.from, to: e.to });
  }
  return { path: resolve(path), entries };
}

// Load the operator-private targets file (the same one import-sessions.mjs
// uses). The path is taken from the explicit `targets` arg (so the CLI's
// `--targets` flag overrides everything), else the `SCRUB_TARGETS` env var
// (the convention the import script establishes), else the default
// `fleet/scrub-targets.json`. The default is intentionally NOT in the
// export allowlist - if the operator keeps their file in the repo, it
// cannot ship. Tests can pass `path: null` to skip loading (the scrub
// will then run without client/vault rules, the same contract the
// importer uses when the file is absent). A malformed file is a hard
// error so the operator sees the breakage instead of silently shipping
// unredacted content. The function is pure (no IO beyond reading the
// file) and is exported so tests can exercise the derivation directly.
export function loadTargetsForExport(opts = {}) {
  // Explicit `path: null` opts out (used by tests and by the --verify
  // mode when the operator doesn't have a targets file).
  if (opts.path === null) {
    return { sourcePath: null, loaded: false, paths: [], tokens: [] };
  }
  const override = opts.path || process.env.SCRUB_TARGETS;
  const sourcePath = (override && String(override).trim()) || DEFAULT_TARGETS_PATH;
  if (!existsSync(sourcePath)) {
    return { sourcePath, loaded: false, paths: [], tokens: [] };
  }
  // Delegate parsing/validation to the importer's loader so the shape
  // is checked in ONE place.
  return loadScrubTargets({ env: { ...process.env, SCRUB_TARGETS: sourcePath }, repoRoot: SCRIPT_ROOT });
}

// --- Safety: refuse to write inside the source tree --------------------------

// True iff `child` is the same path as `parent`, or sits under it.
export function isInside(parent, child) {
  const rel = relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  // On Windows, relative() does not emit a leading separator on the same dir;
  // a value like 'foo/bar' is fine. A value starting with the separator means
  // we are on a different drive letter (rare in tests but possible).
  return !rel.startsWith(sep) || rel === '.';
}

function assertOutOutsideRepo(outDir, repoRoot) {
  const absOut = resolve(outDir);
  const absRoot = resolve(repoRoot);
  if (isInside(absRoot, absOut)) {
    fail(
      'refusing to write --out inside the source repo: ' + absOut + ' is under ' + absRoot,
    );
  }
}

// --- Helpers -----------------------------------------------------------------

export function applyRedactionsToText(text, redactions) {
  let out = String(text);
  const counts = new Array(redactions.length).fill(0);
  for (let i = 0; i < redactions.length; i++) {
    const { from, to } = redactions[i];
    if (!from) continue;
    // Use split/join so the literal value is applied exactly (no regex
    // interpretation), in the operator-supplied order.
    let n = 0;
    let idx = out.indexOf(from);
    while (idx !== -1) {
      out = out.slice(0, idx) + to + out.slice(idx + from.length);
      n += 1;
      idx = out.indexOf(from, idx + to.length);
    }
    counts[i] = n;
  }
  return { text: out, counts };
}

function isProbablyBinary(buf) {
  // Heuristic: a NUL byte in the first 8 KiB is a strong binary marker.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true;
  return false;
}

// Walk a directory recursively, yielding absolute paths. Symlinks are NOT
// followed (the verifier and the scrubber operate on the bytes we copied,
// and a symlink that points inside the repo would silently widen scope).
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

// --- Modes -------------------------------------------------------------------

export function runScan({ allowlist, repoRoot }) {
  const lines = [];
  lines.push(`allowlist: ${allowlist.path} (${allowlist.entries.length} entries)`);
  const missing = [];
  // Group entries by their top-level segment so the tree reads naturally.
  const groups = new Map();
  for (const e of allowlist.entries) {
    const top = e.src.split('/')[0] || e.src;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(e);
  }
  for (const [top, list] of groups) {
    lines.push(top + '/');
    for (const e of list) {
      const abs = join(repoRoot, e.src);
      const ok = existsSync(abs);
      const mark = ok ? 'OK ' : 'MISS';
      const indent = e.src.startsWith(top + '/') ? '  ' : '  ';
      lines.push(`${indent}${mark} ${e.src} -> ${e.dst}`);
      if (!ok) missing.push(e.src);
    }
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`missing sources (${missing.length}):`);
    for (const m of missing) lines.push('  ' + m);
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return { ok: true, missing: [] };
}

export function runCopy({
  allowlist, outDir, repoRoot, redactions, scrubSessions = true, targets,
}) {
  assertOutOutsideRepo(outDir, repoRoot);
  const lines = [];
  lines.push(`allowlist: ${allowlist.path} (${allowlist.entries.length} entries)`);
  if (!scrubSessions) {
    // Loud, stderr warning: a public export that silently skips
    // scrubbing is the failure mode this default exists to prevent.
    // Operators who really want it (e.g. a local mirror) see the
    // warning prominently and have to acknowledge it.
    process.stderr.write(
      'WARNING: --no-scrub-sessions is set. Scrubbable text files will be copied verbatim. ' +
        'Do NOT publish the resulting tree.\n',
    );
  }

  // Load the operator-private targets file ONCE for the whole copy. The
  // scrubber reuses it for every text file; an absent file is not an
  // error - the scrubber simply has fewer rules. The same file drives
  // the import path, so a private value added there takes effect here
  // without any further wiring.
  const targetsForRun = (targets !== undefined)
    ? targets
    : loadTargetsForExport({});
  if (targetsForRun.loaded) {
    lines.push(`targets: ${targetsForRun.sourcePath} (${targetsForRun.paths.length} path rules, ${targetsForRun.tokens.length} token rules)`);
  } else {
    lines.push(`targets: <absent> (using scrub defaults; no client/vault rules)`);
  }

  const missing = [];
  const writtenBytes = { total: 0, files: 0 };
  const redactionHits = redactions.entries.map(() => ({ files: 0, subs: 0 }));
  let scrubbedFiles = 0;
  let codeFilesChecked = 0;
  const codePatternHits = []; // [{src, label, line, masked, at, placeholder?}]
  let codePlaceholderHits = 0; // placeholder matches ignored (mirrors the verify rule's count)
  let abortedReason = null;
  let abortedFiles = 0;

  mkdirSync(resolve(outDir), { recursive: true });
  try {
    for (const e of allowlist.entries) {
      const absSrc = join(repoRoot, e.src);
      const absDst = join(resolve(outDir), e.dst);
      if (!existsSync(absSrc)) {
        missing.push(e.src);
        continue;
      }
      mkdirSync(dirname(absDst), { recursive: true });
      const buf = readFileSync(absSrc);
      const bucket = classifyExtension(e.dst);

      if (bucket === 'code') {
        // CODE FILES: copy byte-identical, then assert it. The
        // assertion is the guard that makes the class of corruption
        // we measured impossible, not just absent today: if any
        // future change accidentally rewrites a code file's bytes
        // (e.g. adding a "scrub" call that runs on every file), the
        // export fails loudly and names the file. A separate scan
        // reports any private string the source still holds so the
        // operator can fix the SOURCE rather than the scrubber.
        writeFileSync(absDst, buf);
        const onDisk = readFileSync(absDst);
        if (onDisk.equals(buf) === false) {
          throw new Error(
            `code file changed during copy (byte-identity broken): ${e.dst}`,
          );
        }
        codeFilesChecked += 1;
        writtenBytes.total += buf.length;
        writtenBytes.files += 1;
        const text = buf.toString('utf8');
        for (const hit of findCodePatternMatches(text)) {
          // Reserved-placeholder client names match the same pattern
          // the verify rule's static baseline uses (mirrors the
          // reserved-email convention). They're never a SOURCE
          // problem — there's nothing to fix because the placeholder
          // was put there by the operator for documentation. Mirror
          // the verify rule: count them in a distinct slot, do NOT
          // add them to the failure set, do NOT abort the copy.
          if (hit.placeholder) {
            codePlaceholderHits += 1;
            continue;
          }
          codePatternHits.push({ src: e.dst, ...hit });
        }
        continue;
      }

      // Anything else: copy first (binary is a byte-identical copy by
      // virtue of the isProbablyBinary gate; text is a starting point
      // we may rewrite below).
      writeFileSync(absDst, buf);
      writtenBytes.total += buf.length;
      writtenBytes.files += 1;

      if (scrubSessions && bucket === 'scrubbable' && !isProbablyBinary(buf)) {
        // Mask kebab-case `sk-...` tokens (CSS custom properties,
        // class names) before the scrubber sees them, and restore
        // them after. Without the mask the scrubber's generic sk-
        // rule rewrites `sk-background-color-default` into
        // `sk-<redacted>`, which corrupts any future CSS shipped in
        // a scrubbable data file. The byte-identity guard above on
        // code files makes the mask moot for `.css`, but data files
        // (e.g. an `.html` fixture that embeds a `sk-` token) still
        // need it.
        const { masked, saved } = maskCssKebabTokens(buf.toString('utf8'));
        const scrubbed = scrub(masked, [], [], targetsForRun);
        const restored = unmaskCssKebabTokens(scrubbed, saved);
        const next = Buffer.from(restored, 'utf8');
        if (next.equals(buf) === false) {
          writeFileSync(absDst, next);
          scrubbedFiles += 1;
        }
      }
      if (redactions.entries.length > 0 && !isProbablyBinary(buf)) {
        // The literal redactions apply AFTER scrubbing so any rule
        // that maps a scrubber placeholder to a public-friendly form
        // (or a fixed value that survives the scrub) is also applied.
        // The disk holds the current bytes — read them, apply
        // redactions, write back only if something changed.
        const current = readFileSync(absDst);
        const { text: out, counts } = applyRedactionsToText(current.toString('utf8'), redactions.entries);
        let touched = false;
        for (let i = 0; i < counts.length; i++) {
          if (counts[i] > 0) {
            touched = true;
            redactionHits[i].files += 1;
            redactionHits[i].subs += counts[i];
          }
        }
        if (touched) writeFileSync(absDst, Buffer.from(out, 'utf8'));
      }
    }
  } catch (err) {
    // A bad targets file, a write error, anything the loop didn't
    // handle: record the failure and bail. The caller then prints the
    // "INCOMPLETE" banner so a half-built tree is never mistaken for
    // a finished export.
    abortedReason = err && err.message ? err.message : String(err);
    abortedFiles = writtenBytes.files;
  }
  lines.push(
    `copied ${writtenBytes.files} files (${writtenBytes.total} bytes) -> ${resolve(outDir)}`,
  );
  if (scrubSessions) {
    lines.push(`scrubbed ${scrubbedFiles} text file(s) with import-sessions.scrub() (scrubbable extensions only)`);
  }
  lines.push(`code files byte-identical: ${codeFilesChecked}/${codeFilesChecked}`);
  if (codePlaceholderHits > 0) {
    // Counterpart to the verify rule's `reserved-placeholder match(es) ignored`
    // detail slot: the placeholder baseline fires here too, but the operator
    // did not put any real private string in the file. Same convention.
    lines.push(`code files with placeholder hits: 0, ${codePlaceholderHits} placeholder match(es) ignored`);
  }
  if (redactions.entries.length > 0) {
    for (let i = 0; i < redactions.entries.length; i++) {
      const r = redactions.entries[i];
      const h = redactionHits[i];
      lines.push(`redaction ${i + 1}: "${trunc(r.from, 40)}" -> "${trunc(r.to, 40)}" touched ${h.files} files (${h.subs} subs)`);
    }
  }
  if (codePatternHits.length > 0) {
    // The scrubber no longer touches code, so a private string inside
    // a code file would ship as-is. Surface every match with file +
    // line + a masked preview, and refuse to declare the copy
    // successful: this is a SOURCE problem (move the string, mask it
    // in source, or drop the file from the allowlist), not something
    // the export can repair without corrupting the tree.
    lines.push('');
    lines.push('!!! CODE FILE CONTAINS PRIVATE PATTERN(S) !!!');
    lines.push('the export tool no longer scrubs code (byte-identical copy), so any');
    lines.push('private string inside a code file would ship as-is. Fix the SOURCE:');
    lines.push('move the string out, mask it at runtime, or drop the file from the allowlist.');
    lines.push('The export cannot repair this without corrupting the shipped tree.');
    lines.push('');
    for (const h of codePatternHits) {
      lines.push(`  ${h.src}:${h.line}  ${h.label}  ->  ${h.masked}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push('missing sources (' + missing.length + '):');
    for (const m of missing) lines.push('  ' + m);
  }
  if (abortedReason !== null) {
    // Loud, distinct banner. The output tree is partial; an operator
    // who reads "copied N files" might miss the failure otherwise.
    lines.push('');
    lines.push('!!! OUTPUT IS INCOMPLETE !!!');
    lines.push(`copy aborted at ${abortedFiles} of ${allowlist.entries.length} entries: ${abortedReason}`);
    lines.push(`the directory ${resolve(outDir)} MUST NOT be published.`);
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
  }
  if (missing.length > 0) {
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return { ok: true, copied: writtenBytes.files, bytes: writtenBytes.total };
}

// True iff the allowlist entry is a session-shaped file. Kept as a
// small helper for the --no-scrub-sessions warning text and any
// future per-shape logic; the copy loop itself no longer gates on
// this (every text file is scrubbed, not just sessions).
function isSessionPath(src) {
  return src === 'sessions' || src.startsWith('sessions/') || src.startsWith('sessions\\');
}

function trunc(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '\u2026';
}

// --verify --------------------------------------------------------------------

function readTextOrNull(p) {
  const buf = readFileSync(p);
  if (isProbablyBinary(buf)) return null;
  return buf.toString('utf8');
}

export function runVerify({ outDir, redactions, targets }) {
  const lines = [];
  if (!outDir) fail('--verify requires a directory');
  const root = resolve(outDir);
  if (!existsSync(root)) fail('verify directory does not exist: ' + root);

  const results = [];
  const files = [...walk(root)];

  const jevHosts = redactions.path ? hostsFromRedactions(redactions) : [];
  const t = (targets !== undefined && targets !== null) ? targets : { loaded: false, paths: [], tokens: [] };
  const vaultNames = vaultNamesFromTargets(t);
  const clientTokens = clientTokensFromTargets(t);
  const operatorUsers = operatorUsernames();

  results.push(checkSecretStrings(files));
  results.push(checkMachinePath(files));
  results.push(checkClientNames(files, clientTokens));
  results.push(checkVaultNames(files, vaultNames));
  results.push(checkOperatorUsernames(files, operatorUsers));
  results.push(checkEmailAddresses(files));
  results.push(checkJevHost(files, jevHosts));
  results.push(checkCodeFilesHaveNoPrivatePatterns(files, clientTokens));

  lines.push(`verify: ${root}`);
  lines.push(`files scanned: ${files.length}`);
  let failed = 0;
  for (const r of results) {
    if (r.skipped) {
      // A skipped rule is NOT a pass. It must be reported as SKIP with
      // a reason, so a reader cannot mistake a rule that did not run
      // for one that did. The class is fixed here, not just for the
      // JEV-host rule: any rule that cannot run must return
      // {skipped: true, skipReason: '...'} and the printer will then
      // emit SKIP, never PASS.
      lines.push(`SKIP ${r.name} -- ${r.skipReason}`);
      continue;
    }
    lines.push(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}` + (r.detail ? ' (' + r.detail + ')' : ''));
    if (r.pass === false) failed += 1;
  }
  process.stdout.write(lines.join('\n') + '\n');
  if (failed > 0) process.exit(1);
  return { ok: true, failed: 0 };
}

// Derive the searchable host(s) from the redactions file. Each entry's
// `from` is a literal the export tool replaces. Two shapes carry a
// host: a URL (e.g. `https://<jev-host>/v1/systemone`) and a bare host
// (e.g. `<jev-host>`). Other shapes (machine paths, run slugs) are not
// hosts and are skipped. The result is de-duplicated; the caller can
// search the tree for ANY of the returned hosts. The function is pure
// (no IO beyond reading the in-memory redactions object) and is
// exported so tests can exercise the derivation directly.
export function hostsFromRedactions(redactions) {
  if (!redactions || !Array.isArray(redactions.entries) || redactions.entries.length === 0) return [];
  const hosts = new Set();
  for (const e of redactions.entries) {
    if (!e || typeof e.from !== 'string') continue;
    const from = e.from;
    if (!from) continue;
    // URL-shaped: take the host portion. `new URL` throws on anything
    // that is not an absolute URL with a scheme, which is exactly the
    // non-host cases we want to skip.
    try {
      const u = new URL(from);
      if (u.host) {
        hosts.add(u.host.toLowerCase());
        continue;
      }
    } catch { /* not a URL */ }
    // Bare-host-shaped: `<label>(.<label>)+` with labels of
    // alphanumerics and internal hyphens. Catches `<jev-host>` and
    // skips machine paths (slashes), run slugs (no dot), and
    // ticket numbers (no dot).
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(from)) {
      hosts.add(from.toLowerCase());
    }
  }
  return [...hosts].sort();
}

function checkSecretStrings(files) {
  const hits = [];
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    if (SECRET_PATTERN.test(t)) hits.push(relativeFromCwd(f));
    // reset lastIndex for the (g-less) regex - safe but defensive
    SECRET_PATTERN.lastIndex = 0;
  }
  return {
    name: 'no secret-shaped strings',
    pass: hits.length === 0,
    detail: hits.length === 0 ? '0 hits' : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}`,
  };
}

function checkMachinePath(files) {
  const hits = [];
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    if (t.includes(MACHINE_PATH)) hits.push(relativeFromCwd(f));
  }
  return {
    name: 'no operator machine path',
    pass: hits.length === 0,
    detail: hits.length === 0 ? '0 hits' : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}`,
  };
}

function checkClientNames(files, clientTokens) {
  // The static CLIENT_NAMES pattern covers the six documented
  // placeholder names (acme / globex / widget / contoso / initech /
  // umbrella) and the runtime targets overlay adds the operator's
  // real client-name token rules. Only the targets-supplied tokens
  // make the rule FAIL — matches against the static placeholder list
  // are filtered and counted separately, mirroring the
  // reserved-email convention. The detail string reports both
  // counts so an operator can tell "the placeholder baseline fired
  // here, but no real client names leaked" from "real client names
  // are present, this rule is correct to FAIL".
  const patterns = [CLIENT_NAMES];
  if (Array.isArray(clientTokens)) {
    for (const src of clientTokens) {
      try { patterns.push(new RegExp(src.source, src.flags)); }
      catch { /* skip an invalid pattern rather than crashing the run */ }
    }
  }
  const hits = [];           // only real (targets-supplied) failures
  let placeholderMatches = 0; // static-baseline matches across the tree
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    let realHit = false;
    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      p.lastIndex = 0;
      if (!p.test(t)) continue;
      if (i === 0) {
        // Static placeholder baseline — never a failure.
        placeholderMatches += 1;
      } else {
        // Targets-supplied token — always a real failure.
        realHit = true;
      }
      break; // first match per file is enough
    }
    if (realHit) hits.push(relativeFromCwd(f));
  }
  const reservedNote = placeholderMatches > 0
    ? `, ${placeholderMatches} reserved-placeholder match(es) ignored`
    : '';
  return {
    name: 'no client project names',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits${reservedNote} (${patterns.length} pattern(s))`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}${reservedNote}`,
  };
}

// Derive client token regexes from the private targets file. Returns
// plain {source, flags} pairs so the caller constructs its own RegExp
// objects (fresh state per file - `lastIndex` does not carry over).
// Pure: no IO. Exported for tests.
export function clientTokensFromTargets(targets) {
  if (!targets || !Array.isArray(targets.tokens)) return [];
  return targets.tokens
    .filter((tk) => tk && typeof tk.pattern === 'string')
    .map((tk) => ({ source: tk.pattern, flags: tk.flags || 'gi' }));
}

// Derive the vault names to search from the private targets file. The
// `paths` array holds {from, to} pairs; the operator lists the vault
// root path first, then the bare name. Both are private strings the
// scrubber removes, so BOTH are verify-rule targets. When a path entry
// is directory-shaped (contains a separator), its last segment - the
// vault's own name - is added as well, so the rule catches the bare
// vault name even when the operator only listed the full path.
// Pure: no IO. Exported for tests.
export function vaultNamesFromTargets(targets) {
  if (!targets || !Array.isArray(targets.paths)) return [];
  const names = new Set();
  for (const p of targets.paths) {
    if (!p || typeof p.from !== 'string' || !p.from) continue;
    names.add(p.from);
    const lastFwd = p.from.split('/').pop();
    const lastBack = p.from.split('\\').pop();
    for (const seg of [lastFwd, lastBack]) {
      if (typeof seg === 'string' && seg.length > 0 && seg !== p.from) names.add(seg);
    }
  }
  return [...names];
}

// The operator's username, derived from os.userInfo() the same way the
// scrubber derives it. Returns an empty array when the username cannot
// be read (some CI environments), so the rule SKIPs rather than PASSing
// on a technicality.
// Pure: no IO beyond the userInfo call. Exported for tests.
export function operatorUsernames() {
  try {
    const u = userInfo().username;
    if (!u) return [];
    return [u, u.toLowerCase(), u.toUpperCase()].filter((v, i, arr) => v && arr.indexOf(v) === i);
  } catch {
    return [];
  }
}

function checkVaultNames(files, vaultNames) {
  if (!Array.isArray(vaultNames) || vaultNames.length === 0) {
    return {
      name: 'no private vault name',
      skipped: true,
      skipReason: 'no vault name derived from the targets file (pass --targets or set SCRUB_TARGETS to enable)',
    };
  }
  const hits = [];
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    for (const v of vaultNames) {
      if (t.includes(v)) {
        hits.push(relativeFromCwd(f) + ':' + trunc(v, 20));
        break;
      }
    }
  }
  return {
    name: 'no private vault name',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits (searched ${vaultNames.length} vault name(s))`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}`,
  };
}

function checkOperatorUsernames(files, users) {
  if (!Array.isArray(users) || users.length === 0) {
    return {
      name: 'no operator username',
      skipped: true,
      skipReason: 'username could not be read from the environment',
    };
  }
  const hits = [];
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    for (const u of users) {
      // Word-bounded so a substring inside a longer token does not
      // count. Case-sensitive: the lowercase and uppercase variants
      // are already in the list, and a mixed-case spelling the
      // operator never used would be noise.
      // The public repo slug (owner/repo) is deliberately published -
      // strip it before testing so the slug is not counted as a hit.
      const probe = t.split('oeganz/jev-agent-orchestrator').join('<owner>/<repo>');
      const re = new RegExp(`\\b${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (re.test(probe)) {
        hits.push(relativeFromCwd(f));
        break;
      }
    }
  }
  return {
    name: 'no operator username',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits (searched ${users.length} form(s))`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}`,
  };
}

// True iff the email's domain (everything after the last `@`, lowercased)
// is a reserved documentation domain - `example.com`/`.net`/`.org`, any
// subdomain of those, or `.invalid`. These are placeholder values
// documentation is SUPPOSED to use; flagging them is noise, not signal.
// The caller counts them separately so the output says how many were
// ignored rather than silently dropping them.
export function isReservedEmailDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const dom = email.slice(at + 1).toLowerCase();
  if (RESERVED_EMAIL_DOMAINS.has(dom)) return true;
  for (const suffix of RESERVED_EMAIL_SUFFIXES) {
    if (dom.endsWith(suffix)) return true;
  }
  return false;
}

function checkEmailAddresses(files) {
  const hits = [];
  let reservedIgnored = 0;
  const EMAIL_GLOBAL = new RegExp(EMAIL_PATTERN.source, 'g');
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    EMAIL_GLOBAL.lastIndex = 0;
    let m;
    while ((m = EMAIL_GLOBAL.exec(t)) !== null) {
      if (isReservedEmailDomain(m[0])) {
        reservedIgnored += 1;
        continue;
      }
      hits.push(relativeFromCwd(f));
      break; // one hit per file is enough to fail the rule
    }
  }
  const reservedNote = reservedIgnored > 0 ? `, ${reservedIgnored} reserved-domain match(es) ignored` : '';
  return {
    name: 'no email addresses',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits${reservedNote}`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}${reservedNote}`,
  };
}

function checkJevHost(files, jevHosts) {
  // A skipped rule must NEVER print as PASS — a reader must not be
  // able to mistake a rule that did not run for one that did. The
  // printer in `runVerify` honours `skipped: true` and prints
  // `SKIP <name> -- <reason>`; this rule returns the same shape
  // whenever it has nothing to search for.
  if (!Array.isArray(jevHosts) || jevHosts.length === 0) {
    return {
      name: 'no JEV host',
      skipped: true,
      skipReason: 'no host derived from --redactions (pass --redactions to enable)',
    };
  }
  const hits = [];
  for (const f of files) {
    const t = readTextOrNull(f);
    if (t === null) continue;
    for (const h of jevHosts) {
      if (t.includes(h)) {
        // Record both file and matched host so a hit is unambiguous
        // when more than one host is searched.
        hits.push(relativeFromCwd(f) + ':' + h);
        break;
      }
    }
  }
  const searched = jevHosts.join(', ');
  return {
    name: 'no JEV host',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits (searched: ${searched})`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}`,
  };
}

// Verify-time companion to the copy-time code-pattern scan. After the
// export copies code files byte-identical, this rule re-scans every
// file with a code extension and FAILs the verify if any private
// pattern is present. One hit per file is enough to fail — the
// detail line carries the first match (label + line + masked preview)
// so the operator can locate the leak without re-running the export.
// Reserved-placeholder client-name matches (the static baseline in
// `_CLIENT_PLACEHOLDERS`) are filtered out of the failure set, mirroring
// the prose rule's reserved-email convention: they are counted and
// reported in `detail`, never fatal. A targets-supplied token match is
// always fatal.
function checkCodeFilesHaveNoPrivatePatterns(files, clientTokens = []) {
  const hits = [];
  let placeholderIgnored = 0;
  for (const f of files) {
    if (classifyExtension(f) !== 'code') continue;
    const t = readTextOrNull(f);
    if (t === null) continue;
    const matches = findCodePatternMatches(t, clientTokens);
    const realMatches = [];
    for (const m of matches) {
      if (m.placeholder) {
        placeholderIgnored += 1;
        continue;
      }
      realMatches.push(m);
    }
    if (realMatches.length > 0) {
      const first = realMatches[0];
      hits.push(`${relativeFromCwd(f)}:${first.line} ${first.label} (${realMatches.length} match(es))`);
    }
  }
  const reservedNote = placeholderIgnored > 0
    ? `, ${placeholderIgnored} reserved-placeholder match(es) ignored`
    : '';
  return {
    name: 'no private patterns in code files',
    pass: hits.length === 0,
    detail: hits.length === 0
      ? `0 hits${reservedNote}`
      : `${hits.length} hits: ${hits.slice(0, 3).join(', ')}${reservedNote}`,
  };
}

function relativeFromCwd(abs) {
  const rel = relative(process.cwd(), abs);
  return rel.startsWith('..') || rel.startsWith(sep) ? abs : rel;
}

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The repo root is the operator's cwd by default - the operator runs the
  // tool from the repo root and the allowlist paths are relative to it.
  const repoRoot = process.cwd();
  // --verify operates on an already-assembled tree; it does NOT need the
  // allowlist, so loading is skipped in that mode (and the default allowlist
  // file does not need to exist for an operator who only wants to verify).
  if (args.mode === 'verify') {
    const redactions = loadRedactions(args.redactions);
    // The verify rules source the vault name and client tokens from the
    // same private targets file the copy step uses. When the operator
    // has no such file, the vault/client rules SKIP (never PASS).
    const targets = loadTargetsForExport({ path: args.targets || undefined });
    runVerify({ outDir: args.out, redactions, targets });
    return;
  }
  const allowlist = loadAllowlist(args.allowlist);
  const redactions = loadRedactions(args.redactions);
  if (args.mode === 'scan') {
    runScan({ allowlist, repoRoot });
    return;
  }
  if (!args.out) fail('--out requires a value (or use --scan / --verify)');
  // For the copy step, load targets once and pass them to the scrubber
  // for every text file. An absent targets file is not an error - the
  // scrubber simply runs with no client/vault rules. A malformed file
  // IS a hard error: the copy may already have written some files when
  // the failure is detected, so the failure path routes through the
  // SAME "OUTPUT IS INCOMPLETE" banner the copy loop uses (D4).
  let targets;
  try {
    targets = loadTargetsForExport({ path: args.targets || undefined });
  } catch (err) {
    mkdirSync(resolve(args.out), { recursive: true });
    process.stdout.write(
      [
        `allowlist: ${allowlist.path} (${allowlist.entries.length} entries)`,
        `!!! OUTPUT IS INCOMPLETE !!!`,
        `copy aborted at 0 of ${allowlist.entries.length} entries: ${err && err.message ? err.message : String(err)}`,
        `the directory ${resolve(args.out)} MUST NOT be published.`,
        '',
      ].join('\n') + '\n',
    );
    process.exit(1);
  }
  runCopy({ allowlist, outDir: args.out, repoRoot, redactions, scrubSessions: args.scrubSessions, targets });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}