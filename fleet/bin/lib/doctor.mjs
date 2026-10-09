// Pure, testable filesystem checks for `fleet doctor`. No I/O beyond stat(),
// no Orca calls, no model probes. The cmdDoctor in fleet.mjs composes these
// rows with the runtime checks (orca reachable, JEV key, model probe) and
// prints + exits; this module only answers "does path P exist?" and "does
// command C resolve on PATH?".
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, delimiter as pathDelimiter } from 'node:path';

// Order matters: this is the order the rows appear in `fleet doctor` output.
// The orchestrator skill depends on each role skill being present, so list
// the role skills first, then the global orchestration skill they reference.
const ROLE_SKILLS = [
  'fleet-orchestrator',
  'fleet-planner',
  'fleet-engineer',
  'fleet-tester',
  'fleet-devops',
  'jev-scoring',
];

// `fsChecks({ root, home })` returns the file-system portion of the doctor
// check list as [[label, ok], ...]. The caller layers on runtime checks and
// controls printing. This helper is pure with respect to its arguments so it
// can be exercised without touching the real repo or homedir.
export function fsChecks({ root, home }) {
  const rows = [];
  for (const name of ROLE_SKILLS) {
    rows.push(['skill ' + name, existsSync(join(root, '.claude', 'skills', name, 'SKILL.md'))]);
  }
  rows.push(['skill orchestration (global)', existsSync(join(home, '.claude', 'skills', 'orchestration', 'SKILL.md'))]);
  return rows;
}

export const ROLE_SKILL_NAMES = ROLE_SKILLS;

// Does `cmd` actually resolve to something executable? resolveOrca() always
// returns a command name (it never checks the filesystem), so a doctor check
// built on it alone can never fail - it was vacuous. This is the real check:
// a command containing a path separator is checked as-is (ORCA_CLI_COMMAND
// may be an absolute or explicit relative path); a bare name must be found in
// one of the PATH directories, trying PATHEXT extensions on Windows first
// and then the extensionless name. Pure: the caller injects pathEnv/pathExt,
// the entry delimiter and the fs-existence predicate, so tests need no real
// binaries and no platform-specific fixtures.
//
// `.cmd`/`.bat` are NOT runnable: Node 24 refuses to execFileSync a batch file
// without a shell (EINVAL, measured 2026-10-07 on orca.cmd), so resolving one
// would make doctor print OK for a command fleet's own Orca calls cannot run.
// Both an explicit .cmd/.bat path and a bare name whose only PATHEXT candidate
// is .cmd/.bat therefore report as unresolved; .exe/.com and extensionless
// names exec fine and still resolve.
//
//   commandResolves(cmd, { pathEnv, pathExt, delimiter, exists, stat })
//     pathEnv   PATH string. Defaults to process.env.PATH.
//     pathExt   Windows PATHEXT string ('.COM;.EXE;...'), '' elsewhere.
//               Defaults to process.env.PATHEXT on win32, '' otherwise.
//     delimiter PATH entry separator (';' on Windows, ':' elsewhere).
//               Defaults to path.delimiter.
//     exists    (absPath) => boolean. Defaults to fs.existsSync.
//     stat      (absPath) => Stats | undefined. Defaults to fs.statSync, with
//               a missing path reported as undefined (never a throw). Used to
//               require a REGULAR FILE - a DIRECTORY passed as
//               ORCA_CLI_COMMAND (e.g. C:/Windows) exists but is not a
//               runnable CLI, so it must not resolve (measured 2026-10-07).
//               A pre-existing `exists` predicate is still honoured as-is so
//               existing injected fixtures (fake paths, not real files) keep
//               working; the stat requirement applies when `exists` is NOT
//               injected, i.e. to every real check doctor performs.
export function commandResolves(cmd, { pathEnv, pathExt, delimiter, exists, stat } = {}) {
  if (!cmd || typeof cmd !== 'string') return false;
  // A shell batch file cannot be spawned by execFileSync (EINVAL on Node 24);
  // never report one as a resolvable CLI, explicit path or PATH candidate.
  if (/\.(cmd|bat)$/i.test(cmd)) return false;
  const fsStat = stat || ((p) => { try { return statSync(p); } catch { return undefined; } });
  // Regular file only: when no `exists` predicate is injected, the path must
  // exist AND be a regular file (statSync().isFile()). A path that does not
  // exist, or that is a directory, is not a resolvable CLI.
  const resolvesTo = (p) => {
    if (exists) return exists(p);
    const st = fsStat(p);
    return !!(st && typeof st.isFile === 'function' && st.isFile());
  };
  if (/[/\\]/.test(cmd)) return resolvesTo(cmd);

  const env = pathEnv === undefined ? process.env.PATH : pathEnv;
  const ext = pathExt === undefined
    ? (process.platform === 'win32' ? process.env.PATHEXT || '' : '')
    : pathExt;
  if (!env) return false;
  const sep = delimiter || pathDelimiter;
  const dirs = env.split(sep).filter(Boolean);
  const suffixes = ext
    ? ext.split(';').filter(Boolean).map((e) => (e.startsWith('.') ? e : '.' + e))
    : [];
  // On Windows an extensionless command also resolves if the exact bare name
  // exists on PATH (a real .exe may be named exactly `orca`); elsewhere the
  // bare name is the only candidate.
  for (const dir of dirs) {
    for (const s of [...suffixes, '']) {
      if (/^\.(cmd|bat)$/i.test(s)) continue;   // this file type is not exec-able
      if (resolvesTo(join(dir, cmd + s))) return true;
    }
  }
  return false;
}

// Run 20261008-1722-lite-track T4-doctor-milestones: enforce the milestone
// protocol's run-store shape at doctor time. The protocol says a run with a
// planner (or an inline run that declares one) ships `milestones.json` with
// `{"milestones":[{"id":"M1","title":"...","tasks":["T1",...], "acceptance":[...], "est_min":N},...]}`
// and every tasks.jsonl/gates.jsonl row carries a `milestone` field. Without
// enforcement the convention rots silently. Legacy runs written before the
// protocol landed (no milestones.json, no `milestone` field on rows) report
// as ADVISORY only - failing on history would make doctor permanently red
// and useless.
//
//   milestoneStoreCheck({ runsDir, readFile, readDir, exists })
//     runsDir   Absolute path to fleet/runs/. Absent => empty store, green.
//     readFile  (absPath) => string. Defaults to fs.readFileSync utf8.
//     readDir   (absPath) => Dirent[]. Defaults to fs.readdirSync w/ types.
//     exists    (absPath) => boolean. Defaults to fs.existsSync.
//
//   Returns [ok, detail] where:
//     ok     - true if every run that has milestones.json passes the
//              structural checks; false if any structural defect was found.
//     detail - one-line human summary, e.g.
//              "17 runs, 3 with milestones.json, 0 broken, 2 legacy runs (advisory)".
//
//   A "structural defect" is anything in milestones.json itself (malformed
//   JSON, missing required fields, bad shapes, references to unknown task
//   ids in tasks.jsonl). A row that lacks `milestone` is an ADVISORY
//   per-row count and never affects ok.
export function milestoneStoreCheck({ runsDir, readFile, readDir, exists } = {}) {
  const _readFile = readFile || ((p) => readFileSync(p, 'utf8'));
  const _readDir = readDir || ((p) => readdirSync(p, { withFileTypes: true }));
  const _exists = exists || existsSync;
  if (!_exists(runsDir)) return [true, '0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)'];

  // Real run dirs: not starting with '_' (excludes fleet/runs/_archive, the
  // terminal-output archive). Same rule the real code uses for runDirs().
  const dirs = _readDir(runsDir)
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  let withMilestones = 0;
  let broken = 0;
  let legacyRuns = 0;
  const brokenNotes = [];

  for (const name of dirs) {
    const runDir = join(runsDir, name);
    const milestonesPath = join(runDir, 'milestones.json');
    const tasksPath = join(runDir, 'tasks.jsonl');
    const gatesPath = join(runDir, 'gates.jsonl');

    if (!_exists(milestonesPath)) {
      // No milestones.json: either legacy (this run predates the protocol)
      // or a one-shot without a planner - either way, advisory. Rows on
      // disk also count as legacy rows below, so the structural check is
      // skipped entirely.
      if (_exists(tasksPath) || _exists(gatesPath)) {
        legacyRuns++;
        continue;
      }
      // Empty run dir with no milestones.json either - not legacy (nothing
      // to flag), not counted as a run with milestones.json. Falls through
      // to the per-row check below for symmetry, but there are no rows.
      legacyRuns++;
      continue;
    }

    withMilestones++;
    let parsed;
    try {
      parsed = JSON.parse(_readFile(milestonesPath));
    } catch (e) {
      broken++;
      brokenNotes.push(`${name}: malformed JSON (${e.message})`);
      continue;
    }
    const milestones = parsed && Array.isArray(parsed.milestones) ? parsed.milestones : null;
    if (!milestones) {
      broken++;
      brokenNotes.push(`${name}: missing or non-array "milestones" key`);
      continue;
    }

    // Collect the set of known task_ids from tasks.jsonl (if present).
    // An empty tasks.jsonl means the run is mid-planning - that is fine for
    // the structural check as long as no milestone references a task. Also
    // count rows that lack the `milestone` field: a run with milestones.json
    // AND a legacy task/gate row is still partially legacy (advisory only -
    // the protocol says rows written before it may lack the field).
    const knownTaskIds = new Set();
    let hasLegacyRow = false;
    if (_exists(tasksPath)) {
      const text = _readFile(tasksPath);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (row && typeof row.task_id === 'string') knownTaskIds.add(row.task_id);
          if (row && typeof row.milestone !== 'string') hasLegacyRow = true;
        } catch {
          // A malformed tasks.jsonl row is not the milestone check's
          // concern - flag the milestone shape only. (Other doctors can
          // validate tasks.jsonl structure separately.)
        }
      }
    }
    if (_exists(gatesPath)) {
      const text = _readFile(gatesPath);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (row && typeof row.milestone !== 'string') hasLegacyRow = true;
        } catch { /* see tasks.jsonl note */ }
      }
    }

    let runBroken = false;
    for (const m of milestones) {
      if (!m || typeof m !== 'object') {
        broken++; runBroken = true;
        brokenNotes.push(`${name}: milestone is not an object`);
        break;
      }
      if (typeof m.id !== 'string' || !m.id) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}: milestone missing string "id"`);
        break;
      }
      if (typeof m.title !== 'string' || !m.title) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: missing string "title"`);
        break;
      }
      if (!Array.isArray(m.tasks) || m.tasks.length === 0) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: "tasks" must be a non-empty array`);
        break;
      }
      if (!m.tasks.every((t) => typeof t === 'string')) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: every "tasks" entry must be a string`);
        break;
      }
      if (!Array.isArray(m.acceptance) || m.acceptance.length === 0) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: "acceptance" must be a non-empty array`);
        break;
      }
      if (!m.acceptance.every((a) => typeof a === 'string')) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: every "acceptance" entry must be a string`);
        break;
      }
      if (typeof m.est_min !== 'number' || !Number.isFinite(m.est_min)) {
        broken++; runBroken = true;
        brokenNotes.push(`${name}/${m.id}: "est_min" must be a finite number`);
        break;
      }
      for (const tid of m.tasks) {
        if (knownTaskIds.size > 0 && !knownTaskIds.has(tid)) {
          broken++; runBroken = true;
          brokenNotes.push(`${name}/${m.id}: task "${tid}" not found in tasks.jsonl`);
          break;
        }
      }
      if (runBroken) break;
    }
    // A run that has milestones.json AND at least one task/gate row lacking
    // the `milestone` field is still partially legacy. Advisory only - the
    // protocol says rows written before it may lack the field. The
    // structural shape of milestones.json is unaffected; broken stays 0.
    if (hasLegacyRow) legacyRuns++;
  }

  const detail =
    `${dirs.length} runs, ${withMilestones} with milestones.json, ${broken} broken` +
    (legacyRuns ? `, ${legacyRuns} legacy run${legacyRuns === 1 ? '' : 's'} (advisory)` : ', 0 legacy runs (advisory)') +
    (brokenNotes.length ? ` - ${brokenNotes.join('; ')}` : '');
  return [broken === 0, detail];
}
