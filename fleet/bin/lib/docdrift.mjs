// `fleet doc-drift <doc.html> <base-sha> [--json] [--fix]` - citation drift detector
// for project-doc HTML. Reuses extractClaims from project-doc.mjs; for every
// non-inferred claim it compares the line at `evidence` between <base-sha> and
// the worktree, classifies drift as same / moved / gone / unresolvable /
// ambiguous, and prints a count plus a per-claim table.
//
// Why this exists: doc-check caught only citations that landed on a BLANK
// line. The dangerous class is a citation that points at TEXT but the WRONG
// text - doc-check stayed green while 61 inserted lines broke 56 of 65
// citations. doc-drift compares the cited line at base vs worktree so a wrong
// line is loud.
//
// Drift classes:
//   same         - cited line identical at base and worktree (after CRLF norm).
//                  Also: a re-run of `--fix` against the same base marks
//                  already-rewritten claims as `same` via the sidecar
//                  (idempotence; see "Sidecar" below).
//   moved        - differs but the base line text exists elsewhere in the
//                  current file. The occurrence CLOSEST to the citation's
//                  current line is the proposed new line; doc claims are
//                  block-ordered, so proximity is the right prior.
//   gone         - base line text does not appear anywhere in the current
//                  file (the content was rewritten or deleted; a human must
//                  review).
//   unresolvable - file does not exist at base (new file; not drift - the
//                  citation is correct against the NEW work). Also: the
//                  evidence is malformed / the cited line is beyond the
//                  base file / the worktree read failed.
//   ambiguous    - base line text occurs MORE THAN ONCE in the current file
//                  and two of those occurrences are EQUIDISTANT from the
//                  citation's current line. `--fix` will NOT rewrite an
//                  ambiguous citation; the caller resolves by hand.
//                  Ambiguous counts as drift (exit 1) so it cannot be
//                  silently green.
//
// Why "ambiguous" exists (T6-docdrift-fix): when the base line text appears
// more than once in the worktree file, the FIRST match is rarely the right
// one (think of repeated help blocks, or text that recurs in a library). A
// wrong-but-plausible rewrite is worse than a blank one: doc-check stays
// green while the citation lands on unrelated text. Proximity is the right
// prior, but when two candidates tie, the safe default is to refuse and ask.
//
// CRLF: `git show <sha>:<file>` yields LF (git stores LF on disk). Windows
// worktrees often use CRLF (core.autocrlf=true). Compare CRLF-normalised.
//
// --fix protocol: after a fix, ADVANCE the base to the commit the citations
// were rewritten against (the orchestrator's documented workflow: doc-drift,
// --fix, commit the doc+source, advance base, doc-drift again to confirm).
// Without advancing, the base content is unchanged and a re-run would
// re-classify the same citation as moved again - which used to confuse the
// orchestrator. To make a re-run against the SAME base a no-op, a sidecar
// file records the per-claim fix; the next detectDrift against the same
// base marks those claims as `same`. Advance the base and the sidecar's
// baseSha no longer matches, so the sidecar is ignored and detection runs
// from scratch.
//
// Sidecar location: under `os.tmpdir()/fleet-docdrift/<sha256>.json` so it
// stays out of the repo (the spec for T6-docdrift-fix explicitly forbids
// polluting `docs/`). The path is a hash of the doc's absolute path so two
// docs in the same session don't collide. Override with `sidecarPath` in
// docDriftCli's deps for tests or for an orchestrator that wants a
// persistent location.
//
// Pure where it can be: gitCmd, readFn, existsFn and sidecarRead/sidecarWrite
// are injectable so the tests can drive any fixture without touching a
// real repo - and the end-to-end tests build a tiny git repo under
// os.tmpdir() (never /tmp, which does not exist when Node runs natively on
// Windows).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { extractClaims } from './project-doc.mjs';

// Parse evidence "path:line" or "path:line-line". Returns {rel, start, end}
// or {err}. Mirrors the regex project-doc.mjs uses for validateEvidence, so
// the same input grammar is accepted; rejects ranges (cited claims are
// single-line; if a citation becomes a range later, classify the start).
function parseEvidence(ev) {
  if (!ev || typeof ev !== 'string') return { err: 'empty evidence' };
  // Take the last colon as the line-number separator. This lets the path
  // contain colons (rare, but `C:foo` is a malformed input we still want
  // to surface as "absolute" rather than "malformed" - the regex used
  // here, the same one project-doc.mjs uses for validateEvidence, would
  // split on the FIRST colon and would claim `C` is the relative path).
  const lastColon = ev.lastIndexOf(':');
  if (lastColon === -1) return { err: `malformed evidence: ${ev}` };
  const rel = ev.slice(0, lastColon);
  const tail = ev.slice(lastColon + 1);
  const range = /^(-?\d+)(?:-(-?\d+))?$/.exec(tail);
  if (!range) return { err: `malformed evidence: ${ev}` };
  if (rel.includes('..')) return { err: `evidence escapes root: ${ev}` };
  if (isAbsolute(rel) || rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) {
    return { err: `evidence is absolute: ${ev}` };
  }
  const start = parseInt(range[1], 10);
  const end = range[2] ? parseInt(range[2], 10) : start;
  if (start < 1) return { err: `line number ${start} must be >= 1: ${ev}` };
  return { rel, start, end };
}

// CRLF normalisation: replace any CRLF / lone CR with LF so a base commit
// (LF) and a worktree file (CRLF on Windows) compare identically. This is
// the exact trap that produced a false alarm on the milestone run.
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n');
}

// Default git command: execFileSync is the only safe way to invoke git from
// Node without a shell (avoid the .cmd/.bat ENOENT / EINVAL trap). The
// caller injects a stub in tests so this module never needs a real repo.
function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Default read: matches project-doc.mjs's "read file as utf8" shape. Tests
// inject so they can drive the worktree text without real fs.
function defaultRead(p) {
  return readFileSync(p, 'utf8');
}

// Resolve a repo root from an absolute doc path. The spec says evidence paths
// in the doc are relative to the repo root - so for `docs/project-doc.html`,
// the repo root is the parent of `docs/`'s parent (one level up from the
// directory holding the doc). Walk up until we find a `.git` entry; if none
// is found, fall back to the directory holding the doc (the spec's "repo
// root from the doc path" is best-effort when no git metadata exists).
function findRepoRoot(absoluteDocPath) {
  let cur = dirname(absoluteDocPath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirname(absoluteDocPath);
}

// Default sidecar path: under os.tmpdir() so the cache stays out of the
// repo. The path is a sha256 prefix of the doc's absolute path so two docs
// in the same session don't collide on the same basename.
function defaultSidecarPath(absDocPath) {
  const h = createHash('sha256').update(String(absDocPath)).digest('hex').slice(0, 16);
  return join(tmpdir(), 'fleet-docdrift', `${h}.json`);
}

// Read a sidecar from disk. Returns null when the file is missing,
// unparseable, or not an object. The tests inject this so they can drive
// the cache state without a real fs; production uses the default which
// never throws on a missing or corrupt file (we'd rather run from a cold
// cache than fail the whole run on a sidecar glitch).
function defaultSidecarRead(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Write a sidecar to disk. Creates the parent directory if needed (the
// fleet-docdrift dir under tmpdir may not exist on a cold machine).
function defaultSidecarWrite(absPath, sidecar) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(sidecar, null, 2));
}

// Build a new sidecar from the previous one and a set of new fixes. If
// the base has changed, the previous fixes are stale and discarded (the
// orchestrator's documented protocol is to advance the base after --fix).
// The newest fix for a claimId wins.
function buildSidecar(prevSidecar, baseSha, newFixes) {
  const keep = (prevSidecar && prevSidecar.baseSha === baseSha)
    ? (Array.isArray(prevSidecar.fixes) ? prevSidecar.fixes : [])
    : [];
  const byClaim = new Map();
  for (const f of [...keep, ...newFixes]) {
    if (f && f.claimId) byClaim.set(f.claimId, f);
  }
  return {
    version: 1,
    baseSha,
    fixedAt: new Date().toISOString(),
    fixes: Array.from(byClaim.values()),
  };
}

// Drift-classify one citation. See the module header for the drift classes.
//
// `gitCmd([..., cwd])` defaults to execFileSync('git', ...). `readFn(p)`
// defaults to readFileSync with utf8 (CRLF is normalised after the read).
// `existsFn(p)` defaults to existsSync (injected by tests so they can
// pretend a worktree file does or does not exist without a real fs).
// `prevSidecar` is the sidecar loaded from disk; if its baseSha matches
// the current baseSha, a fix record exists for this claim, and the
// citation's current evidence still matches the fix's newEvidence,
// return `same` (the rewrite is already accepted; --fix is a no-op on
// re-run). `claimId` keys the sidecar lookup; tests that don't care
// about idempotence can omit it.
function classifyOne({ ev, baseSha, claimId, prevSidecar, repoRoot, gitCmd = defaultGit, readFn = defaultRead, existsFn = existsSync }) {
  const parsed = parseEvidence(ev);
  if (parsed.err) return { status: 'unresolvable', reason: parsed.err };

  // Idempotence check (see module header). Same-base re-runs of --fix
  // must be a no-op. If the sidecar's base matches AND the citation
  // still points at the sidecar's newEvidence, the orchestrator has
  // already accepted the rewrite; treat as `same`.
  if (prevSidecar && prevSidecar.baseSha === baseSha && claimId) {
    const fixes = Array.isArray(prevSidecar.fixes) ? prevSidecar.fixes : [];
    const prev = fixes.find(f => f && f.claimId === claimId);
    if (prev && prev.newEvidence === ev) {
      return { status: 'same', idempotent: true, prevFix: prev };
    }
  }

  const { rel, start } = parsed;
  const repoRel = rel; // evidence paths are repo-relative; `end` is unused
                       // (single-line citations only)

  // Pull the base version. `git show <sha>:<path>` exits non-zero if the
  // file did not exist at <sha> - that is the "new file" / unresolvable
  // case (a new file is not drift; the doc could legitimately cite it).
  let baseText;
  try {
    baseText = gitCmd(['show', `${baseSha}:${repoRel}`], repoRoot);
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).trim();
    return { status: 'unresolvable', reason: `file missing at ${baseSha}: ${msg || repoRel}` };
  }
  const baseLines = normalize(baseText).split('\n');
  if (start > baseLines.length) {
    return { status: 'unresolvable', reason: `cited line ${start} beyond base ${repoRel} (${baseLines.length} lines)` };
  }
  const baseLine = baseLines[start - 1];

  const workAbs = join(repoRoot, repoRel);
  if (!existsFn(workAbs)) {
    return {
      status: 'gone',
      base: baseLine,
      baseFile: repoRel,
      baseLine: start,
      reason: `file missing in worktree: ${repoRel}`,
    };
  }
  let workText;
  try { workText = readFn(workAbs); } catch (e) {
    return { status: 'unresolvable', reason: `worktree read failed: ${e?.message || e}` };
  }
  const workLines = normalize(workText).split('\n');
  const workLine = start <= workLines.length ? workLines[start - 1] : undefined;

  if (workLine !== undefined && normalize(workLine) === baseLine) {
    return { status: 'same', base: baseLine, baseFile: repoRel, baseLine: start };
  }

  // Differ at the cited line. Search the current file for the base line
  // text. Match on a normalized line - CRLF is already stripped, so a
  // CRLF worktree and an LF base find the same text on either side of
  // the search.
  //
  // A blank base line (whitespace-only) is NOT a meaningful anchor: any
  // blank line in the worktree would satisfy the search and we would
  // report a bogus "moved" to the first one. doc-check already errors on
  // a blank cited line; here we report gone so a human sees the citation
  // lost its content.
  if (baseLine.trim() !== '') {
    // Collect EVERY occurrence of the base line text. The original
    // implementation stopped at the first match - which silently wrote
    // the WRONG line when the text recurs (T6-docdrift-fix). With the
    // full set we can pick by proximity.
    const found = [];
    for (let i = 0; i < workLines.length; i++) {
      if (normalize(workLines[i]) === baseLine) found.push(i + 1);
    }
    if (found.length === 1) {
      return {
        status: 'moved',
        base: baseLine,
        baseFile: repoRel,
        baseLine: start,
        newLine: found[0],
      };
    }
    if (found.length > 1) {
      // Multiple matches. Pick the one closest to the citation's current
      // line number (doc claims are block-ordered; proximity is the
      // right prior). If two candidates are equidistant, REFUSE to
      // rewrite and report `ambiguous` - a wrong-but-plausible line is
      // worse than a blank one, and a human can pick the right one.
      let best = found[0];
      let bestDist = Math.abs(found[0] - start);
      let tie = false;
      for (let i = 1; i < found.length; i++) {
        const d = Math.abs(found[i] - start);
        if (d < bestDist) { best = found[i]; bestDist = d; tie = false; }
        else if (d === bestDist) { tie = true; }
      }
      if (tie) {
        return {
          status: 'ambiguous',
          base: baseLine,
          baseFile: repoRel,
          baseLine: start,
          candidates: found.slice(),
        };
      }
      return {
        status: 'moved',
        base: baseLine,
        baseFile: repoRel,
        baseLine: start,
        newLine: best,
      };
    }
  }

  return {
    status: 'gone',
    base: baseLine,
    baseFile: repoRel,
    baseLine: start,
    reason: baseLine.trim() === ''
      ? 'base line was blank (no text to search for)'
      : 'base line text not found anywhere in current file',
  };
}

// Slice a line for the table - first 60 chars (after CRLF norm), with a one-
// line marker if it was longer. Keeping the formatter separate lets the
// JSON consumer and the table consumer read the same field name (`first`).
function first60(text) {
  const flat = normalize(text).replace(/\n/g, ' ');
  return flat.length > 60 ? flat.slice(0, 60) + '...' : flat;
}

// Run drift detection on a doc.
//
//   html               - the doc's HTML text
//   baseSha            - the commit to compare the doc's citations against
//   opts.repoRoot      - absolute path to the repo root (defaults to the dir
//                        holding the doc; tests pass an explicit root)
//   opts.gitCmd        - injectable; default is execFileSync('git', ...)
//   opts.readFn        - injectable; default readFileSync utf8
//   opts.prevSidecar   - injectable; the sidecar loaded from disk. When set
//                        AND its baseSha matches baseSha, a claim whose
//                        current evidence matches the sidecar's newEvidence
//                        is reported as `same` (idempotence).
//
// Returns { total, byStatus, claims } where each claim has {id, source,
// evidence, status, base, baseFile, baseLine, newLine?, candidates?, reason?}.
export function detectDrift(html, baseSha, opts = {}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (typeof baseSha !== 'string' || !baseSha) throw new TypeError('baseSha must be a non-empty string');
  const repoRoot = opts.repoRoot;
  const gitCmd = opts.gitCmd || defaultGit;
  const readFn = opts.readFn || defaultRead;
  const existsFn = opts.existsFn || existsSync;
  const prevSidecar = opts.prevSidecar || null;

  const claims = extractClaims(html);
  const rows = [];
  for (const c of claims) {
    if (!c.evidence) {
      // inferred / evidence-less claims are not drift candidates
      rows.push({ id: c.id, source: c.source, evidence: c.evidence || '', status: 'same', skip: 'no evidence' });
      continue;
    }
    const r = classifyOne({
      ev: c.evidence, baseSha, claimId: c.id, prevSidecar,
      repoRoot, gitCmd, readFn, existsFn,
    });
    rows.push({
      id: c.id, source: c.source, evidence: c.evidence,
      status: r.status,
      base: r.base || null,
      baseFile: r.baseFile || null,
      baseLine: r.baseLine || null,
      newLine: r.newLine ?? null,
      candidates: r.candidates ?? null,
      reason: r.reason || null,
      idempotent: r.idempotent || false,
      first: r.base != null ? first60(r.base) : null,
    });
  }
  const counts = { same: 0, moved: 0, gone: 0, unresolvable: 0, ambiguous: 0 };
  for (const r of rows) {
    if (r.skip === 'no evidence') continue; // inferred / evidence-less are not drift candidates
    if (counts[r.status] === undefined) continue;
    counts[r.status]++;
  }
  // total counts every non-skipped citation. Skipped (no evidence) is
  // excluded because it isn't a citation - extracted inferred claims are
  // not drift candidates by definition.
  const total = rows.filter(r => r.skip !== 'no evidence').length;
  return { total, byStatus: counts, baseSha, claims: rows };
}

// Print the human table. Header + counts + one row per moved/gone/
// ambiguous/unresolvable claim. Same claims are listed by count, not by
// row, because at typical project-doc scale they outnumber the drift rows
// by 10x and a wall of "same" rows hides the rows a human has to act on.
function humanTable(report) {
  const out = [];
  out.push(`base:     ${report.baseSha}`);
  const { same, moved, gone, unresolvable, ambiguous } = report.byStatus;
  const drift = moved + gone + ambiguous;
  const clean = same + unresolvable;
  out.push(`citations:  ${report.total}  (clean: ${clean}, drift: ${drift})`);
  out.push(`           same: ${same}   moved: ${moved}   gone: ${gone}   ambiguous: ${ambiguous}   unresolvable: ${unresolvable}`);
  // The drift + unresolvable rows are what a human reads; same is just a
  // count. Sorted by id so the diff between two runs is diff-friendly.
  const rows = report.claims
    .filter(r => r.status === 'moved' || r.status === 'gone' || r.status === 'unresolvable' || r.status === 'ambiguous')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!rows.length) {
    out.push('');
    out.push('no drift');
    return out.join('\n');
  }
  out.push('');
  out.push(['claim', 'old', 'new', 'first 60 chars of the base text'].join('  '));
  out.push('-'.repeat(78));
  for (const r of rows) {
    const oldLine = r.baseLine != null ? String(r.baseLine) : '-';
    let newLine;
    if (r.status === 'moved') newLine = String(r.newLine);
    else if (r.status === 'ambiguous') newLine = 'cand:' + (r.candidates || []).join(',');
    else newLine = '-';
    out.push([
      r.id.padEnd(10),
      oldLine.padEnd(6),
      newLine.padEnd(15),
      (r.first || r.reason || '').slice(0, 60),
    ].join('  '));
  }
  return out.join('\n');
}

// CLI surface - `fleet doc-drift <html> <base-sha> [--json] [--fix]`.
// Returns the exit code; the caller sets process.exitCode so a non-zero
// doesn't kill the process when the report printer also writes.
export async function docDriftCli(argv, deps = {}) {
  const log = deps.log || ((...a) => console.log(...a));
  const readF = deps.readFileSync || readFileSync;
  const writeF = deps.writeFileSync || writeFileSync;
  const existsF = deps.existsSync || existsSync;
  const findRoot = deps.findRepoRoot || findRepoRoot;
  const sidecarRead = deps.sidecarRead || defaultSidecarRead;
  const sidecarWrite = deps.sidecarWrite || defaultSidecarWrite;
  const sidecarPathFn = deps.sidecarPath || ((abs) => defaultSidecarPath(abs));
  const positional = [];
  let asJson = false;
  let doFix = false;
  for (const a of argv || []) {
    if (a === '--json') asJson = true;
    else if (a === '--fix') doFix = true;
    else if (a.startsWith('--')) {
      log('unknown flag: ' + a);
      log('usage: fleet doc-drift <doc.html> <base-sha> [--json] [--fix]');
      return 2;
    } else positional.push(a);
  }
  const [htmlPath, baseSha] = positional;
  if (!htmlPath || !baseSha) {
    log('usage: fleet doc-drift <doc.html> <base-sha> [--json] [--fix]');
    return 2;
  }
  const abs = resolve(htmlPath);
  if (!existsF(abs)) {
    log('no such file: ' + htmlPath);
    return 1;
  }
  // Tests pass repoRoot explicitly; production resolves it by walking up
  // to the nearest .git (the doc is usually under docs/, so its own dir is
  // not the repo root).
  const repoRoot = deps.repoRoot || findRoot(abs);

  // Validate the base ref FIRST. A typo'd sha makes every citation
  // unresolvable (git show fails for every file) and the tool would exit 0
  // looking clean - exactly the "green while lying" failure this command
  // exists to prevent. A git/ref error is a usage error: exit 2.
  const gitVerify = deps.gitCmd || defaultGit;
  try {
    gitVerify(['rev-parse', '--verify', `${baseSha}^{commit}`], repoRoot);
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).trim().split('\n')[0];
    log(`cannot resolve base ref "${baseSha}" in ${repoRoot}: ${msg || 'git rev-parse failed'}`);
    log('  (pass a commit sha or ref that exists in this repo)');
    return 2;
  }

  let html;
  try { html = readF(abs, 'utf8'); }
  catch (e) {
    log('read failed: ' + (e?.message || e));
    return 1;
  }

  // Load the sidecar (idempotence cache). When its baseSha matches the
  // current base, claims the orchestrator has already rewritten against
  // this base are reported as `same` instead of being re-classified as
  // `moved` against the unchanged base content.
  const sidecarPath = sidecarPathFn(abs);
  const prevSidecar = sidecarRead(sidecarPath);

  const report = detectDrift(html, baseSha, { repoRoot, prevSidecar });
  if (asJson) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(humanTable(report));
  }

  if (doFix) {
    const fix = applyFix(html, report);
    // Atomic write: the read and the write happen in sequence on the same
    // path, and nothing interleaves them (a single-process, single-file
    // tool run by humans). Node has no cross-platform atomic-rename
    // primitive on Windows, so this one-write is the atomicity we can offer.
    writeF(abs, fix.html);
    if (fix.count > 0) {
      log(`fix: rewrote ${fix.count} data-evidence entr${fix.count === 1 ? 'y' : 'ies'} in ${htmlPath}`);
      // Surface ambiguous explicitly so the operator knows --fix left
      // claims behind (it MUST - rewriting an ambiguous claim would
      // require guessing which candidate is the right one).
      const ambig = report.byStatus.ambiguous || 0;
      if (ambig > 0) {
        log(`fix: left ${ambig} ambiguous claim${ambig === 1 ? '' : 's'} unrewritten (resolve by hand - see candidates above)`);
      }
      log('after committing, advance the base and rerun to confirm.');
      // Save the sidecar so a re-run against the same base is a no-op.
      // Without this, the next run would re-classify the same citations
      // as moved (the base content is unchanged) and confuse the
      // orchestrator. See module header for the protocol.
      const newSidecar = buildSidecar(prevSidecar, baseSha, fix.rewritten);
      sidecarWrite(sidecarPath, newSidecar);
    } else {
      log(`fix: nothing to rewrite in ${htmlPath}`);
      // When a re-run finds nothing to rewrite, the sidecar is still
      // useful: it explains the no-op (the prior run already rewrote).
      if (prevSidecar && prevSidecar.baseSha === baseSha) {
        log('  (claims were already rewritten by a prior --fix against this base - advance the base to confirm)');
      }
    }
  }

  // Drift = moved + gone + ambiguous. same and unresolvable are not
  // drift (unresolvable means "we can't tell"; a new file at base is
  // correct against the new work, so it isn't drift). ambiguous counts
  // as drift so it cannot be silently green - the operator must see
  // it and resolve by hand.
  const drift = report.byStatus.moved + report.byStatus.gone + report.byStatus.ambiguous;
  return drift > 0 ? 1 : 0;
}

// Rewriter for --fix. Splits the doc into claim-tag spans; for any claim
// whose row is `moved`, replaces the `data-evidence` attribute with the
// new line. Leaves `gone`, `same`, `unresolvable`, `ambiguous` and
// inferred (no-evidence) claims alone. Done with a parser-light approach
// (find attribute by name, confirm we are inside a `class` containing
// the literal `claim`) so we do not reimplement extractClaims here.
//
// We do this on the text (not the JSON projection) so what we write is byte-
// equal to the input except for the attribute we just edited - no Front-
// matter or quote style drift, no implicit trim.
//
// Returns { html, count, rewritten: [{claimId, oldEvidence, newEvidence}, ...] }
// where `rewritten` is the per-claim log used to build the sidecar.
function applyFix(html, report) {
  const idxById = new Map();
  for (const r of report.claims) if (r.id) idxById.set(r.id, r);
  const re = /(<[^>]*class\s*=\s*["'][^"']*\bclaim\b[^>]*?\bdata-(?:claim|source|evidence)\s*=\s*["'][^"']*["'][^>]*>)/g;
  let count = 0;
  const rewritten = [];
  const replaced = html.replace(re, (whole) => {
    const claim = whole.match(/\bdata-claim\s*=\s*["']([^"']+)["']/);
    if (!claim) return whole;
    const row = idxById.get(claim[1]);
    if (!row || row.status !== 'moved') return whole;
    // Replace the data-evidence attribute on this tag, preserving everything
    // else (including trailing `>` and other attributes).
    const evOld = whole.match(/(\bdata-evidence\s*=\s*["'])([^"']*)(["'])/);
    if (!evOld) return whole;
    // Reuse the file/line format the input used (path:line).
    const newEv = `${row.baseFile}:${row.newLine}`;
    // Defensive no-op: if the citation is already at the proposed new
    // line, skip. This is belt-and-braces with the sidecar's
    // idempotence check - the sidecar covers the "re-run against the
    // SAME base" path; this covers the "re-run with a different base
    // but the same citation value" path (unusual but possible).
    if (evOld[2] === newEv) return whole;
    rewritten.push({ claimId: claim[1], oldEvidence: evOld[2], newEvidence: newEv });
    count++;
    return whole.replace(evOld[0], `${evOld[1]}${newEv}${evOld[3]}`);
  });
  return { html: replaced, count, rewritten };
}

export const __test__ = {
  parseEvidence,
  normalize,
  classifyOne,
  applyFix,
  first60,
  humanTable,
  findRepoRoot,
  buildSidecar,
  defaultSidecarPath,
  defaultSidecarRead,
  defaultSidecarWrite,
};
