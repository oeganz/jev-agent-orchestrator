// Import Claude session transcripts into sessions/, scrubbing credentials.
//
//   node fleet/bin/import-sessions.mjs [--source <dir>]
//
// Writes two trees:
//   sessions/raw/<id>.jsonl   the untouched copy (gitignored - never committed)
//   sessions/<id>.jsonl       the scrubbed copy (committed)
//   sessions/INDEX.md         id, date, size, first prompt, per session
//
// The raw transcripts contain the literal contents of .env and of anything
// pasted into a session, so committing them would put live API keys in git
// history permanently. The scrubbed copy is what goes into the repo.
//
// How secrets are redacted:
//   1. Pattern-only: every recognised key shape is caught by regex. The
//      scrubber never embeds a credential value in source.
//   2. Operator-driven: any value the operator has set in process.env whose
//      NAME ends in API_KEY/KEY/TOKEN/SECRET/PASSWORD is also redacted
//      verbatim. Empty / unset values are skipped so the scrubber still runs
//      when no secret has been configured yet.
//
// Operator-specific scrubbing (machine path, client list, vault root/name):
//   1. Machine path is derived at runtime from `os.userInfo().username` so
//      the source contains no real username. The rule works on any machine.
//   2. Client project names and the vault root / bare vault name come from
//      an OPTIONAL private targets file. Absent by default - the scrubber
//      runs with no client rules and no vault rule and never crashes. The
//      path is taken from the `SCRUB_TARGETS` env var (so the operator can
//      point at any private file outside the repo) or the repo-relative
//      default `fleet/scrub-targets.json`. The file is intentionally NOT
//      listed in `fleet/export-public/allowlist.json`, so it never ships
//      with a public release.
//
// Targets file shape (JSON). Real client names and the real vault root
// live in the operator's private copy of this file (kept out of git by
// convention; never in the public-repo allowlist), not in this module -
// so a public release does not ship the strings the scrubber exists to
// hide. The example below uses invented names.
//   {
//     "paths": [
//       { "from": "C:/AI/operator-vault-root", "to": "<repo>" },
//       { "from": "operator-vault-name",        "to": "<vault>" }
//     ],
//     "tokens": [
//       { "pattern": "\\bclient-one\\b",   "replace": "<client>", "flags": "gi" },
//       { "pattern": "\\bclient-two\\b",   "replace": "<client>", "flags": "gi" }
//     ]
//   }
//
// `paths` is an array of literal string replacements. ORDER MATTERS: the
// more specific entry (the vault root path) MUST be listed BEFORE the
// less specific entry (the bare vault name) so the path rule wins on
// the same span of text. `tokens` is an array of regex replacements
// for client project names; each entry's `pattern` is a regex source,
// `flags` is the regex flags (default `gi`), and `replace` is the
// placeholder (typically `<client>`).
//
// The file is OPTIONAL. The scrubber works with no such file: no
// client rules, no vault rule, no crash.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, loadSettingsEnv } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// PATTERNS contains ONLY patterns that are not operator-specific. The
// operator's machine path and bare username are built dynamically from
// `os.userInfo().username`; the operator's client list and vault
// root/name come from an optional private targets file (see
// `loadTargets` below).
//
// Ordering invariant (preserved from the prior scrubber):
//   1. secrets   (literal from env, then regex shapes)
//   2. paths     (machine home dir, from os.userInfo)
//   3. emails    (static pattern; covers client-substring cases)
//   4. clients   (regex tokens, from the targets file)
//   5. hosts     (static <jev-host> pattern (constructed from the env
//                 var JEV_HOST at load time so the source file does
//                 not contain a real host), then runtime `*_BASE_URL`
//                 hosts)
//   6. vault     (root path -> <repo>, then bare name -> <vault>; the
//                 more specific path rule wins because it is listed
//                 first in the targets file's `paths` array)
//   7. bare username (catch-all, after every other rule)
//
// The "secrets FIRST" ordering is load-bearing: a credential that
// happens to appear inside a machine path or an email is fully
// redacted before the structural rule rewrites the surrounding text.
export const PATTERNS = [
  // --- secrets (kept in this order from prior scrubber) ---------------
  // Anthropic API keys (sk-ant-api03-...)
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-<redacted>'],
  // OpenRouter keys (sk-or-v1-...)
  [/sk-or-v1-[A-Za-z0-9]{20,}/g, 'sk-or-v1-<redacted>'],
  // Bearer tokens - capture prefix in group 1 so the value is replaced but
  // the `Bearer ` word stays in place.
  [/(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1<redacted>'],
  // Generic sk-... keys (OpenAI, other providers). Listed after sk-or-v1 so
  // OpenRouter's longer prefix wins.
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-<redacted>'],
  // JEV-style keys (kn-...)
  [/\bkn-[A-Za-z0-9]{20,}/g, 'kn-<redacted>'],
  // gbrain tokens (kept from the prior scrubber for back-compat with the
  // existing committed sessions/*.jsonl files).
  [/\bgbrain_[a-f0-9]{20,}/gi, 'gbrain_<redacted>'],
  // X-ZenoA-Key header value (kept from the prior scrubber).
  [/(X-ZenoA-Key["'\s:=]{1,6})[A-Za-z0-9._-]{6,}/gi, '$1<redacted>'],
  // Bare `NAME=value` lines whose NAME smells like a secret (KEY|TOKEN|
  // SECRET|PASSWORD). The name is kept so the operator can tell which secret
  // it was; only the value is replaced.
  [/([A-Z_][A-Z0-9_]*(?:API_KEY|API_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD)["'\s:=]{1,6})[^\s"',;\\]{8,}/g, '$1<redacted>'],

  // --- email addresses ----------------------------------------------
  // Standard RFC-ish shape - any `@x.yz` with a TLD. Replaces the whole
  // address; no need to keep the domain in place.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],

  // --- operator endpoints (static) ---------------------------------
  // The JEV host -> `<jev-host>`. The host is sourced at scrub time
  // from the JEV_HOST env var (operator-supplied) so the source file
  // does not embed a real hostname. The pattern is a sentinel: the
  // `scrub()` function replaces the operator's JEV_HOST literal with
  // the sentinel FIRST, then PATTERNS replaces the sentinel with the
  // `<jev-host>` placeholder. This way the source file holds neither
  // a real hostname nor a private placeholder, and the env var can
  // change after module load. Other endpoint hosts come from runtime
  // env (`*_BASE_URL`) and are processed by `scrub()`.
  [/\b__JEV_HOST_SENTINEL__\b/gi, '<jev-host>'],
];

// Escape a string for safe inclusion in a RegExp source. The operator
// username may contain regex special characters on unusual systems;
// without this, the dynamic patterns in `machinePathPatterns` and
// `bareUsernamePatterns` could throw `Invalid regular expression`.
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the machine-path patterns dynamically from the CURRENT
// operator username, so the source contains no real username. Two
// forms are matched:
//   (a) JSONL-escaped: `C:\\Users\<user>\` (each backslash doubled - the
//       dominant form in JSON-encoded transcripts). Matches TWO
//       literal backslashes between each segment.
//   (b) Rendered:      `C:/Users/<user>/` and `C:\Users\<user>\`
//       (any case, single slash or single backslash). Matches ONE
//       slash-or-backslash between each segment.
// The escaped form is listed first so the more specific (longer) match
// wins when both could apply to the same span of text.
export function machinePathPatterns() {
  const user = userInfo().username;
  if (!user) return [];
  return [
    // Escaped form: each backslash is doubled in the input. In the
    // regex string passed to new RegExp, each `\\` is one backslash,
    // so 4 chars in the string (8 in the template source) yield 2
    // backslashes in the regex - matching 2 literal backslashes.
    [new RegExp(`[A-Za-z]:\\\\\\\\Users\\\\\\\\${reEscape(user)}\\\\\\\\`, 'gi'), '<machine-path>/'],
    // Rendered form: single slash or single backslash between segments.
    // The char class `[\/\\]` in regex syntax; in a string we write
    // `[/\\]` (4 chars) so new RegExp parses it as a char class of
    // slash or backslash.
    [new RegExp(`[A-Za-z]:[/\\\\]Users[/\\\\]${reEscape(user)}[/\\\\]`, 'gi'), '<machine-path>/'],
  ];
}

// Build the bare-username catch-all pattern dynamically. Catches the
// operator's username ANY time it appears with word boundaries (e.g.
// in `ls -l` listings, prose, or anywhere a path-shaped rule could not
// fire). Placed AFTER the path rule in the scrub pipeline so a real
// path keeps its readable `<machine-path>/...` shape where possible,
// and AFTER the vault rules so a leftover username inside a partially
// redacted vault token is still scrubbed.
export function bareUsernamePatterns() {
  const user = userInfo().username;
  if (!user) return [];
  return [[new RegExp(`\\b${reEscape(user)}\\b`, 'gi'), '<user>']];
}

// Default location of the optional operator-private targets file. The
// file is intentionally NOT listed in `fleet/export-public/allowlist.json`,
// so even when present on disk it never ships with a public release.
// See the module header for the file shape.
const DEFAULT_TARGETS_PATH = join(ROOT, 'fleet', 'scrub-targets.json');

// Load the optional private targets file. The path is taken from
// `SCRUB_TARGETS` env var (so an operator can point it at any private
// file outside the repo) or the repo-relative default. A missing file
// is NOT an error - the scrubber just runs without client/vault rules.
// A present-but-malformed file IS an error, so the operator sees the
// breakage instead of silently shipping unredacted content.
export function loadTargets(opts = {}) {
  const env = opts.env || process.env;
  const repoRoot = opts.repoRoot || ROOT;
  const override = env.SCRUB_TARGETS;
  const sourcePath = (override && String(override).trim()) || join(repoRoot, 'fleet', 'scrub-targets.json');
  if (!existsSync(sourcePath)) {
    return { sourcePath, loaded: false, paths: [], tokens: [] };
  }
  let data;
  try { data = JSON.parse(readFileSync(sourcePath, 'utf8')); }
  catch (err) { throw new Error(`cannot parse targets file ${sourcePath}: ${err.message}`); }
  const paths = Array.isArray(data && data.paths) ? data.paths : [];
  const tokens = Array.isArray(data && data.tokens) ? data.tokens : [];
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (!p || typeof p.from !== 'string' || typeof p.to !== 'string') {
      throw new Error(`targets.paths[${i}] must be {from: string, to: string}`);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || typeof t.pattern !== 'string' || typeof t.replace !== 'string') {
      throw new Error(`targets.tokens[${i}] must be {pattern: string, replace: string, flags?: string}`);
    }
  }
  return { sourcePath, loaded: true, paths, tokens };
}

// Hosts discovered at runtime from `*_BASE_URL` env vars. The scrubber
// extracts the host portion (never the URL value, which can carry a
// secret in the userinfo or path) so a transcript cannot leak a private
// LLM endpoint just because the operator pointed `ANTHROPIC_BASE_URL`
// at their proxy. An unparseable value is skipped; an empty env yields
// no hosts; `.id`-style public-infrastructure hosts the operator wants
// redacted verbatim are handled by the static PATTERNS entry above
// rather than here. The static pattern is constructed at module load
// from the JEV_HOST env var so the source file does not embed the
// real hostname.
export function runtimeHosts(env = process.env) {
  const jevHost = String(env.JEV_HOST || '').trim();
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/_?BASE_URL(?:[0-9]+)?$/i.test(k)) continue;
    const s = String(v ?? '').trim();
    if (!s) continue;
    let host;
    try { host = new URL(s).host; } catch { continue; }
    if (!host) continue;
    // The JEV host (whatever the operator sets it to) is handled by
    // the static PATTERNS entry with its own `<jev-host>` placeholder;
    // skip here so the runtime pass doesn't reduce it to a generic
    // `<endpoint-host>` placeholder.
    if (jevHost && host.toLowerCase() === jevHost.toLowerCase()) continue;
    out.push(host);
  }
  return out;
}

// Build the runtime literal list from process.env. The scrubber must NEVER
// embed credentials in source - the only way a literal value enters the
// redaction list is if the operator set it (e.g. JEV_API_KEY in .env or
// ~/.claude/settings.json). Any env var whose name ends in API_KEY / KEY /
// KEY2 / TOKEN / SECRET / PASSWORD is captured; values shorter than 8 chars
// are skipped to avoid false positives on placeholders.
export function runtimeSecrets(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD)(?:[0-9]+)?$/i.test(k)) continue;
    const s = String(v ?? '').trim();
    if (s.length >= 8) out.push(s);
  }
  return out;
}

export function scrub(text, literals = runtimeSecrets(), hosts = runtimeHosts(), targets) {
  let out = String(text);
  // 0. the operator-configured JEV host -> sentinel, so the static
  //    pattern below (which holds a sentinel, not a real hostname) can
  //    later rewrite it to `<jev-host>`. Done BEFORE the runtime hosts
  //    pass so the JEV host is never reduced to a generic
  //    `<endpoint-host>` placeholder.
  const jevHost = String(process.env.JEV_HOST || '').trim();
  if (jevHost) {
    const esc = jevHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), '__JEV_HOST_SENTINEL__');
  }
  // 1. literal secrets from env (empty/unset env => no rules, no crash)
  for (const lit of literals) {
    if (!lit) continue;
    out = out.split(lit).join('<redacted>');
  }
  // 2. runtime endpoint hosts from env
  for (const host of hosts) {
    if (!host) continue;
    out = out.split(host).join('<endpoint-host>');
  }
  // 3. static patterns (secrets, emails, JEV host via sentinel)
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  // 4. machine paths (env-derived from os.userInfo)
  for (const [re, to] of machinePathPatterns()) out = out.replace(re, to);
  // 5. client tokens (from targets file)
  const t = (targets !== undefined) ? targets : loadTargets();
  for (const tk of (t.tokens || [])) {
    out = out.replace(new RegExp(tk.pattern, tk.flags || 'gi'), tk.replace);
  }
  // 6. vault rules: root path -> <repo> (more specific) and bare name
  //    -> <vault> (less specific). Order in the `paths` array is the
  //    operator's responsibility - the path entry MUST come first.
  for (const p of (t.paths || [])) {
    if (!p.from) continue;
    out = out.split(p.from).join(p.to);
  }
  // 7. bare-username catch-all (env-derived, belt-and-braces)
  for (const [re, to] of bareUsernamePatterns()) out = out.replace(re, to);
  return out;
}

function firstPrompt(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const c = o.message && o.message.content;
    const t = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ')
        : '';
    const s = (t || '').replace(/\s+/g, ' ').trim();
    // Skip harness preamble wrappers; the real first ask is the substantive one.
    if (s.length < 12) continue;
    return s.slice(0, 110);
  }
  return '';
}

async function main() {
  // Surface values from .env / ~/.claude/settings.json into process.env so
  // the scrubber sees whatever the operator set, without it ever appearing
  // in source. Has no effect when no such file exists or no relevant keys
  // are set.
  loadEnv();
  loadSettingsEnv();

  const HOME = process.env.USERPROFILE || process.env.HOME || '';
  // Default SOURCE: the operator's Claude projects dir for this repo.
  // The exact project dir name is operator-specific (it is a hash of
  // the cwd the operator used), so we DO NOT hard-code it here. The
  // operator must pass --source <dir>, or set the FLEET_SOURCE env
  // var. When neither is set, we fall back to a placeholder and the
  // tool prints a loud error rather than guessing the wrong directory.
  const FLEET_SOURCE = process.env.FLEET_SOURCE;
  const SOURCE = process.argv.includes('--source')
    ? process.argv[process.argv.indexOf('--source') + 1]
    : FLEET_SOURCE || join(HOME, '.claude', 'projects', '<vault>');
  const SESSIONS = join(ROOT, 'sessions');
  const RAW = join(SESSIONS, 'raw');

  if (!existsSync(SOURCE)) {
    console.error('source not found: ' + SOURCE);
    process.exit(1);
  }
  mkdirSync(RAW, { recursive: true });

  const files = readdirSync(SOURCE).filter((f) => f.endsWith('.jsonl'));
  const rows = [];
  let totalRaw = 0;

  for (const f of files) {
    const src = join(SOURCE, f);
    const text = readFileSync(src, 'utf8');
    const size = statSync(src).size;
    totalRaw += size;

    writeFileSync(join(RAW, f), text);
    writeFileSync(join(SESSIONS, f), scrub(text));

    rows.push({
      id: basename(f, '.jsonl'),
      date: new Date(statSync(src).mtime).toISOString().slice(0, 10),
      kb: Math.round(size / 1024),
      prompt: firstPrompt(text),
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

  const md = [
    '# Session transcripts',
    '',
    'Every Claude session whose working directory was this repo, oldest first.',
    'The `.jsonl` beside this file is the **scrubbed** copy that lives in the repo;',
    '`raw/` holds the untouched originals and is gitignored.',
    '',
    'Regenerate with `node fleet/bin/import-sessions.mjs` from the repo root.',
    '',
    `${rows.length} sessions, ${(totalRaw / 1024 / 1024).toFixed(1)} MB raw.`,
    '',
    '| session | date | size | first prompt |',
    '|---|---|---|---|',
    ...rows.map((r) => `| \`${r.id.slice(0, 8)}\` | ${r.date} | ${r.kb} KB | ${r.prompt.replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');

  writeFileSync(join(SESSIONS, 'INDEX.md'), md);
  console.log(`imported ${rows.length} sessions (${(totalRaw / 1024 / 1024).toFixed(1)} MB) -> sessions/`);
  console.log('scrubbed copies + INDEX.md written; raw originals in sessions/raw/ (gitignored)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
