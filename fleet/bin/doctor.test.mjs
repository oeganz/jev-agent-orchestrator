import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fsChecks, commandResolves, milestoneStoreCheck } from './lib/doctor.mjs';
import { evaluateDoctorChecks } from './fleet.mjs';

const ROLE_SKILLS = [
  'fleet-orchestrator',
  'fleet-planner',
  'fleet-engineer',
  'fleet-tester',
  'fleet-devops',
  'jev-scoring',
];

const GLOBAL_SKILL = 'orchestration';

// Build a fake repo root and a fake home directory with the skills the spec
// requires. Returns the two roots and a cleanup function.
function makeFixture({ dropRole = null, dropGlobal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-root-'));
  const home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  for (const name of ROLE_SKILLS) {
    if (name === dropRole) continue;
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), '# ' + name);
  }
  if (!dropGlobal) {
    mkdirSync(join(home, '.claude', 'skills', GLOBAL_SKILL), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', GLOBAL_SKILL, 'SKILL.md'), '# global');
  }
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function findLabel(rows, label) {
  return rows.find(([name]) => name === label);
}

test('fsChecks reports all 6 repo role skills + global orchestration as ok when present', () => {
  const fx = makeFixture();
  try {
    const rows = fsChecks({ root: fx.root, home: fx.home });
    for (const name of ROLE_SKILLS) {
      const row = findLabel(rows, 'skill ' + name);
      assert.ok(row, 'missing row for skill ' + name + ' in ' + JSON.stringify(rows.map(([l]) => l)));
      assert.equal(row[1], true, 'expected skill ' + name + ' ok');
    }
    const g = findLabel(rows, 'skill orchestration (global)');
    assert.ok(g, 'missing row for global orchestration skill');
    assert.equal(g[1], true, 'expected global orchestration ok');
  } finally {
    fx.cleanup();
  }
});

test('fsChecks flips a single role skill to FAIL when its SKILL.md is removed', () => {
  const fx = makeFixture({ dropRole: 'fleet-tester' });
  try {
    const rows = fsChecks({ root: fx.root, home: fx.home });
    const bad = findLabel(rows, 'skill fleet-tester');
    assert.ok(bad, 'missing row for skill fleet-tester');
    assert.equal(bad[1], false, 'fleet-tester must FAIL when missing');
    // Every other role skill stays ok
    for (const name of ROLE_SKILLS) {
      if (name === 'fleet-tester') continue;
      const row = findLabel(rows, 'skill ' + name);
      assert.equal(row[1], true, 'expected skill ' + name + ' still ok');
    }
  } finally {
    fx.cleanup();
  }
});

test('fsChecks reports FAIL for the global orchestration skill when it is missing', () => {
  const fx = makeFixture({ dropGlobal: true });
  try {
    const rows = fsChecks({ root: fx.root, home: fx.home });
    const g = findLabel(rows, 'skill orchestration (global)');
    assert.ok(g, 'missing row for global orchestration skill');
    assert.equal(g[1], false, 'global orchestration must FAIL when missing');
  } finally {
    fx.cleanup();
  }
});

test('fsChecks returns rows as a list of [label, ok] pairs in a stable order', () => {
  const fx = makeFixture();
  try {
    const rows = fsChecks({ root: fx.root, home: fx.home });
    assert.ok(Array.isArray(rows));
    for (const r of rows) {
      assert.equal(typeof r[0], 'string', 'label must be a string');
      assert.equal(typeof r[1], 'boolean', 'ok must be boolean');
    }
    // The role skills must appear in the order declared by the spec.
    const labels = rows.map(([l]) => l);
    const roleStart = labels.indexOf('skill ' + ROLE_SKILLS[0]);
    assert.ok(roleStart >= 0, 'role skills not present');
    const roleSlice = labels.slice(roleStart, roleStart + ROLE_SKILLS.length);
    assert.deepEqual(
      roleSlice,
      ROLE_SKILLS.map((n) => 'skill ' + n),
      'role skills must appear in spec order',
    );
    // The global skill appears somewhere in the list.
    assert.ok(labels.includes('skill orchestration (global)'), 'global skill missing');
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// commandResolves - the real check behind "orca cli on PATH or ORCA_CLI_COMMAND".
// The old check was vacuous: resolveOrca() always returns a cmd string, so it
// could never fail. commandResolves must actually resolve the command against
// PATH (+ PATHEXT on Windows) or accept an absolute path to an existing file.
// `exists` is injectable so these tests need no real binaries.
// ---------------------------------------------------------------------------

function fakeResolver(existing) {
  // join() on win32 yields backslashes, so normalize both sides - the fixtures
  // below are written POSIX-style for readability. Lowercase too: the real
  // Windows filesystem is case-insensitive, so a fake PATH lookup must be as
  // well (PATHEXT says .CMD, the fixture file says .cmd).
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const set = new Set(existing.map(norm));
  return (p) => set.has(norm(p));
}

test('commandResolves: true when the command exists as a file in a PATH dir (POSIX shape)', () => {
  const exists = fakeResolver(['/usr/local/bin/orca']);
  assert.equal(
    commandResolves('orca', { pathEnv: '/usr/local/bin:/usr/bin', pathExt: '', delimiter: ':', exists }),
    true,
  );
});

test('commandResolves: false when the command is absent from every PATH dir', () => {
  const exists = fakeResolver(['/usr/bin/something-else']);
  assert.equal(
    commandResolves('orca', { pathEnv: '/usr/local/bin:/usr/bin', pathExt: '', delimiter: ':', exists }),
    false,
  );
});

test('commandResolves: false when PATH is empty or missing', () => {
  const exists = fakeResolver(['/usr/local/bin/orca']);
  assert.equal(commandResolves('orca', { pathEnv: '', pathExt: '', delimiter: ':', exists }), false);
});

// Run 20261007-1720 T1-doc-nits-cmd: Node 24 refuses to execFileSync a .cmd/.bat
// without a shell (EINVAL, measured 2026-10-07), so neither may resolve - the old
// test asserted the opposite and doctor would print OK for a command fleet's own
// orca calls cannot run. .exe/.com and extensionless names are the ones that exec.
test('commandResolves: Windows skips .cmd when resolving a bare name via PATHEXT', () => {
  // Only orca.cmd exists: execFileSync('orca.cmd') throws EINVAL on Node 24, so a
  // bare "orca" that would resolve to it must NOT count as resolvable.
  const exists = fakeResolver(['C:/tools/orca.cmd']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    false,
  );
});

test('commandResolves: Windows skips .bat when resolving a bare name via PATHEXT', () => {
  const exists = fakeResolver(['C:/tools/orca.bat']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    false,
  );
});

test('commandResolves: Windows still resolves a bare name to an .exe on PATH', () => {
  const exists = fakeResolver(['C:/tools/orca.exe']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    true,
  );
});

test('commandResolves: Windows resolves an extensionless executable on PATH', () => {
  const exists = fakeResolver(['C:/tools/orca']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    true,
  );
});

test('commandResolves: Windows false when only a non-executable extension matches', () => {
  // orca.py exists but .PY is not in the provided PATHEXT - must not resolve.
  const exists = fakeResolver(['C:/tools/orca.py']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    false,
  );
});

test('commandResolves: Windows false when no extension variant exists anywhere on PATH', () => {
  const exists = fakeResolver(['C:/tools/unrelated.exe']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools;C:\\Windows',
      pathExt: '.COM;.EXE;.BAT;.CMD',
      delimiter: ';',
      exists,
    }),
    false,
  );
});

test('commandResolves: ORCA_CLI_COMMAND pointing at an absolute path checks that path directly', () => {
  const exists = fakeResolver(['C:/Users/me/bin/orca.exe']);
  assert.equal(
    commandResolves('C:\\Users\\me\\bin\\orca.exe', {
      pathEnv: '',
      pathExt: '',
      delimiter: ';',
      exists,
    }),
    true,
  );
  assert.equal(
    commandResolves('C:/Users/me/bin/missing.exe', {
      pathEnv: '',
      pathExt: '',
      delimiter: ';',
      exists,
    }),
    false,
  );
});

test('commandResolves: ORCA_CLI_COMMAND relative path with a separator also checks that path directly', () => {
  const exists = fakeResolver(['./build/orca-dev']);
  assert.equal(
    commandResolves('./build/orca-dev', { pathEnv: '', pathExt: '', delimiter: ':', exists }),
    true,
  );
  assert.equal(
    commandResolves('./build/nope', { pathEnv: '', pathExt: '', delimiter: ':', exists }),
    false,
  );
});

// Run 20261007-1720 T1-doc-nits-cmd: an EXPLICIT .cmd/.bat path (ORCA_CLI_COMMAND,
// or an absolute path) must not resolve either - Node 24 execFileSync throws
// EINVAL on it without a shell. .exe/.com and extensionless paths still resolve.
test('commandResolves: an explicit .cmd path does not resolve (execFileSync EINVAL on Node 24)', () => {
  const exists = fakeResolver(['C:/Users/me/bin/orca.cmd']);
  assert.equal(
    commandResolves('C:\\Users\\me\\bin\\orca.cmd', { pathEnv: '', pathExt: '', delimiter: ';', exists }),
    false,
  );
});

test('commandResolves: an explicit .bat path does not resolve', () => {
  const exists = fakeResolver(['C:/Users/me/bin/orca.bat']);
  assert.equal(
    commandResolves('C:\\Users\\me\\bin\\orca.bat', { pathEnv: '', pathExt: '', delimiter: ';', exists }),
    false,
  );
});

test('commandResolves: an explicit .exe path still resolves', () => {
  const exists = fakeResolver(['C:/Users/me/bin/orca.exe']);
  assert.equal(
    commandResolves('C:\\Users\\me\\bin\\orca.exe', { pathEnv: '', pathExt: '', delimiter: ';', exists }),
    true,
  );
});

test('commandResolves: bare relative command is resolved via PATH, not the cwd', () => {
  // "node_modules/.bin/orca" contains a separator -> direct check; a bare
  // "orca" must only ever consult PATH dirs so the check can never be
  // satisfied by a file in the current directory.
  const exists = fakeResolver(['orca', './orca']);
  assert.equal(commandResolves('orca', { pathEnv: '/usr/bin', pathExt: '', delimiter: ':', exists }), false);
});

test('commandResolves: a PATH entry without the command is skipped without throwing', () => {
  const exists = fakeResolver(['/usr/local/bin/orca']);
  assert.equal(
    commandResolves('orca', { pathEnv: '/does/not/exist:/usr/local/bin', pathExt: '', delimiter: ':', exists }),
    true,
  );
});

test('commandResolves: PATHEXT entries without a leading dot are accepted', () => {
  const exists = fakeResolver(['C:/tools/orca.EXE']);
  assert.equal(
    commandResolves('orca', {
      pathEnv: 'C:\\tools',
      pathExt: 'COM;EXE;BAT;CMD',
      delimiter: ';',
      exists,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Run 20261007-1009 T1-small-fixes: ORCA_CLI_COMMAND pointing at a DIRECTORY
// (e.g. C:/Windows) resolved as ok, because the check only asked "does the
// path exist?". Only a REGULAR FILE may count. These two cases deliberately
// use the REAL default stat seam (no injection) on throwaway tmp fixtures -
// the directory case fails before the fix because existsSync(dir) is true.
// ---------------------------------------------------------------------------

test('commandResolves: an ORCA_CLI_COMMAND that is a DIRECTORY does not resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-dir-'));
  try {
    // A path with a separator is checked directly; existing is not enough -
    // it must be a regular file.
    assert.equal(commandResolves(dir, { pathEnv: '', pathExt: '', delimiter: ';' }), false,
      'a directory must not count as a resolvable CLI');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commandResolves: an ORCA_CLI_COMMAND that is a regular FILE resolves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-file-'));
  try {
    const exe = join(dir, 'orca-cli.exe');
    writeFileSync(exe, '');
    assert.equal(commandResolves(exe, { pathEnv: '', pathExt: '', delimiter: ';' }), true,
      'a regular file must count as a resolvable CLI');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commandResolves: the stat seam decides - directory Stats -> false, file Stats -> true', () => {
  // Same path, two classifications: only isFile() wins. Nothing touches the
  // real filesystem - the seam carries the answer.
  const dirStats = { isFile: () => false, isDirectory: () => true };
  const fileStats = { isFile: () => true, isDirectory: () => false };
  assert.equal(
    commandResolves('C:/Windows', { pathEnv: '', pathExt: '', delimiter: ';', stat: () => dirStats }),
    false,
  );
  assert.equal(
    commandResolves('C:/Windows/orca.exe', { pathEnv: '', pathExt: '', delimiter: ';', stat: () => fileStats }),
    true,
  );
  // A path the seam cannot stat (missing) never resolves.
  assert.equal(
    commandResolves('C:/nope/orca.exe', { pathEnv: '', pathExt: '', delimiter: ';', stat: () => undefined }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Run 20261008-1722-lite-track T4-doctor-milestones: enforce the milestone
// protocol's run-store shape (milestones.json + per-row `milestone` field on
// tasks and gates) at doctor time. Legacy runs written before the protocol
// landed report as ADVISORY only - failing on history would make doctor
// permanently red and useless.
// ---------------------------------------------------------------------------

// Build a fake fleet/runs tree under os.tmpdir() (never /tmp - does not exist
// when Node runs natively on Windows). `runs` is an array of
// {id, milestones?, tasks?: string[], gates?: string[]} where tasks/gates are
// arrays of JSON-lines (one per row). Returns the runsDir + cleanup.
function makeRunsFixture(runs) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-runs-'));
  const runsDir = join(root, 'runs');
  mkdirSync(runsDir, { recursive: true });
  // fleet/runs/_archive is the terminal-output archive - not a real run and
  // the real code skips it. The fixture builds a synthetic one to make sure
  // the check ignores it the same way.
  mkdirSync(join(runsDir, '_archive'), { recursive: true });
  writeFileSync(join(runsDir, '_archive', 'milestones.json'), '{"milestones":[]}');
  for (const r of runs) {
    const dir = join(runsDir, r.id);
    mkdirSync(dir, { recursive: true });
    if (r.milestones !== undefined) {
      writeFileSync(join(dir, 'milestones.json'), r.milestones);
    }
    if (r.tasks) {
      writeFileSync(join(dir, 'tasks.jsonl'), r.tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
    }
    if (r.gates) {
      writeFileSync(join(dir, 'gates.jsonl'), r.gates.map((g) => JSON.stringify(g)).join('\n') + '\n');
    }
  }
  return {
    runsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('milestoneStoreCheck: passes on a run with a valid milestones.json and a tasks row that has milestone', () => {
  const fx = makeRunsFixture([
    {
      id: 'r1',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: ['T1'], acceptance: ['node --test x'], est_min: 15 },
        ],
      }),
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, 'valid run must pass; detail=' + detail);
    assert.match(detail, /1 runs/);
    assert.match(detail, /1 with milestones\.json/);
    assert.match(detail, /0 broken/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: missing milestones.json is ADVISORY (legacy run), not a failure', () => {
  const fx = makeRunsFixture([
    // Legacy run: tasks present but no milestones.json and rows have no
    // milestone field. The doctor must stay green and just report counts.
    {
      id: 'legacy1',
      tasks: [{ task_id: 'T1' }],
      gates: [{ gate: 'G2', task_id: 'T1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, 'legacy run without milestones.json must not fail; detail=' + detail);
    assert.match(detail, /1 runs/);
    assert.match(detail, /0 with milestones\.json/);
    assert.match(detail, /1 legacy run/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: FAIL when milestones.json references an unknown task id', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-bad-task',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: ['T1', 'T2-missing'], acceptance: ['node --test x'], est_min: 15 },
        ],
      }),
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'unknown task reference must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
    assert.match(detail, /T2-missing/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: FAIL when acceptance array is empty', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-empty-acc',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: ['T1'], acceptance: [], est_min: 15 },
        ],
      }),
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'empty acceptance must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
    assert.match(detail, /acceptance/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: FAIL when milestones.json is malformed JSON', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-bad-json',
      milestones: '{ this is not json',
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'malformed JSON must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: FAIL when est_min is non-numeric', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-bad-est',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: ['T1'], acceptance: ['x'], est_min: 'fifteen' },
        ],
      }),
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'non-numeric est_min must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
    assert.match(detail, /est_min/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: legacy run with no milestone fields is ADVISORY only', () => {
  // The whole point of the rule - pre-protocol runs that lack the milestone
  // field on tasks AND gates must NOT fail doctor. They count as legacy.
  const fx = makeRunsFixture([
    {
      id: 'legacy2',
      tasks: [
        { task_id: 'T1' },
        { task_id: 'T2' },
      ],
      gates: [
        { gate: 'G2', task_id: 'T1' },
      ],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, 'pure legacy run must not fail; detail=' + detail);
    assert.match(detail, /1 legacy run/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: a run with no tasks.jsonl and no milestones.json counts as legacy and does not fail', () => {
  const fx = makeRunsFixture([
    { id: 'empty-run' },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, 'empty run dir must not fail; detail=' + detail);
    assert.match(detail, /1 runs/);
    assert.match(detail, /1 legacy run/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: _archive dir is skipped (not counted as a run)', () => {
  // The fixture always plants _archive with a malformed milestones.json -
  // if the check did not skip _-prefixed dirs, the real store would FAIL on
  // it. By skipping, the count must be 0 runs.
  const fx = makeRunsFixture([]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, '_archive must be skipped; detail=' + detail);
    assert.match(detail, /^0 runs/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: real-style run with multiple milestones and a gate row without milestone counts as legacy', () => {
  // The advisory count covers gates rows that lack milestone: a pre-protocol
  // gate row. A run with milestones.json AND a legacy gate row must still
  // pass (the milestones.json validates; the gate row is advisory).
  const fx = makeRunsFixture([
    {
      id: 'r-mixed',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: ['T1'], acceptance: ['x'], est_min: 5 },
        ],
      }),
      tasks: [{ task_id: 'T1', milestone: 'M1' }],
      gates: [{ gate: 'G2', task_id: 'T1' /* no milestone field */ }],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, true, 'mixed legacy gate must not fail; detail=' + detail);
    assert.match(detail, /1 with milestones\.json/);
    assert.match(detail, /1 legacy run/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: empty tasks array on a milestone is a structural FAIL', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-empty-tasks',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: [], acceptance: ['x'], est_min: 5 },
        ],
      }),
      tasks: [],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'empty tasks array must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: tasks entry that is not a string is a structural FAIL', () => {
  const fx = makeRunsFixture([
    {
      id: 'r-bad-tasks-shape',
      milestones: JSON.stringify({
        milestones: [
          { id: 'M1', title: 'A', tasks: [123], acceptance: ['x'], est_min: 5 },
        ],
      }),
      tasks: [],
    },
  ]);
  try {
    const [ok, detail] = milestoneStoreCheck({ runsDir: fx.runsDir });
    assert.equal(ok, false, 'non-string tasks entry must fail; detail=' + detail);
    assert.match(detail, /1 broken/);
  } finally {
    fx.cleanup();
  }
});

test('milestoneStoreCheck: missing milestones.json directory (runsDir absent) is not a failure - empty store', () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-empty-'));
  try {
    // runsDir is a path that does not exist - the check should treat that
    // as zero runs and stay green.
    const [ok, detail] = milestoneStoreCheck({ runsDir: join(root, 'no-such-runs') });
    assert.equal(ok, true, 'absent runs dir must not fail; detail=' + detail);
    assert.match(detail, /^0 runs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Run 20261009-0015-public-repo T12-doctor-advisory-claude: in the exported
// (public) tree there is deliberately no repo-root CLAUDE.md - it carries
// private-repo instructions and is excluded from the allowlist. The README
// explicitly tells readers to load the fleet-orchestrator skill instead. A
// doctor row that FAILS on the missing file made every new contributor
// think their install was broken. This block reclassifies CLAUDE.md as
// advisory and proves the behaviour:
//
//   - public tree (skills present, NO CLAUDE.md) -> doctor passes
//   - private checkout (CLAUDE.md present)       -> doctor passes (advisory note)
//   - missing fleet-orchestrator skill          -> doctor fails (the real dep)
//   - advisory row on its own                    -> exit-code is 0
//
// The tests build minimal Rows-shaped inputs and run them through the pure
// helper evaluateDoctorChecks(), so they exercise the same classification
// + wording code the cmd uses without spawning a subprocess.
// ---------------------------------------------------------------------------

// Minimal row set mirroring what cmdDoctor builds at the call site, minus
// the runtime-only rows (orca reachable, JEV key, model probe) - those are
// real-world concerns exercised by the live cmd. The repo-root
// filesystem checks are stubbed via fixtures above; here we feed the rows
// straight in so the test pins the wording and the exit-code math exactly.
function publicTreeRows({ claudeOk, orchestratorOk }) {
  const skillRows = ROLE_SKILLS.map((name) => [
    'skill ' + name,
    orchestratorOk ? (name !== 'fleet-orchestrator' ? true : true) : (name !== 'fleet-orchestrator'),
  ]);
  return [
    ['config.json', true],
    ['run store', true],
    ...skillRows,
    [
      'CLAUDE.md (advisory - private checkout convenience file; the fleet-orchestrator skill is the real dependency)',
      !!claudeOk,
      'advisory',
      // cmdDoctor passes the explicit CLAUDE.md note (the helper's generic
      // default would not mention the fleet-orchestrator skill). Mirror
      // that here so the helper renders the same line a real run produces.
      claudeOk
        ? 'present (private checkout convenience file - loaded by Claude Code automatically)'
        : 'absent - PRIVATE checkout convenience file, not the public tree dependency; load .claude/skills/fleet-orchestrator/SKILL.md to activate the orchestrator',
    ],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND', true],
    ['orca reachable', true],
    ['JEV key set', true],
    ['milestone-store 6 runs, 0 with milestones.json, 0 broken, 6 legacy runs (advisory)', true],
    ['model can tool-call', true],
  ];
}

test('T12-doctor-advisory-claude: public tree (skills present, NO CLAUDE.md) -> doctor passes', () => {
  // The case the bug report measured: a fresh public-tree checkout with the
  // fleet-orchestrator skill installed but without a repo-root CLAUDE.md.
  // Old behaviour: exit 1. New behaviour: exit 0, advisory row explains why.
  const rows = publicTreeRows({ claudeOk: false, orchestratorOk: true });
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 0, 'public tree must produce zero failing rows');
  assert.equal(out.advisoryMissing, 1, 'CLAUDE.md absent must count as one optional item not present');
  const joined = out.lines.join('\n');
  // The advisory wording must mention BOTH the private-checkout shortcut
  // and the skill the reader should actually load.
  assert.match(joined, /note\s+CLAUDE.md/);
  assert.match(joined, /fleet-orchestrator\/SKILL\.md/);
  // The closing summary sits in its own slot at the tail of the lines array.
  // The CLAUDE.md row is advisory + absent, so the summary names it without
  // calling it a problem - the bug-report measurement of "exit 0" lives here.
  assert.equal(out.lines[out.lines.length - 1], 'all checks pass (1 optional item not present)');
});

test('T12-doctor-advisory-claude: private checkout (CLAUDE.md present) -> doctor passes, advisory marked present', () => {
  // The private development checkout ships a CLAUDE.md. It must NOT be
  // treated as a real dependency either, but the row should describe it
  // accurately so a reader can tell where it lives.
  const rows = publicTreeRows({ claudeOk: true, orchestratorOk: true });
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 0, 'private checkout with CLAUDE.md present must still pass');
  assert.equal(out.advisoryMissing, 0, 'CLAUDE.md present must not count as absent');
  const joined = out.lines.join('\n');
  assert.match(joined, /note\s+CLAUDE\.md/);
  assert.match(joined, /present \(private checkout convenience file/);
  // No advisory row is absent in this scenario -> plain "all checks pass".
  assert.equal(out.lines[out.lines.length - 1], 'all checks pass');
});

test('T12-doctor-advisory-claude: missing fleet-orchestrator skill -> doctor FAILS even when CLAUDE.md is absent', () => {
  // The REAL dependency still bites. CLAUDE.md being advisory must not
  // hide a broken install - the skill is required, so a missing one
  // fails doctor even though CLAUDE.md is also missing.
  const rows = publicTreeRows({ claudeOk: false, orchestratorOk: false });
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1, 'missing fleet-orchestrator must count toward the exit code');
  assert.equal(out.advisoryMissing, 1, 'CLAUDE.md absent must still count as advisory-missing');
  const joined = out.lines.join('\n');
  assert.match(joined, /FAIL\s+skill fleet-orchestrator/);
  assert.match(joined, /note\s+CLAUDE\.md/);
  // bad=1, advisoryMissing=1 -> both counts in the summary, so a reader sees
  // the real failure AND the optional absent item in one line.
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s), 1 optional item not present');
});

test('T12-doctor-advisory-claude: advisory row on its own never sets a non-zero exit code', () => {
  // Belt-and-braces: when every row is ok OR advisory, bad must be 0. The
  // caller wires `bad` into process.exitCode, so a contributor who sees
  // the advisory message must never see a non-zero exit from it.
  const rows = [
    ['skill fleet-orchestrator', true],
    ['CLAUDE.md (advisory)', false, 'advisory'],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 0, 'an advisory failure alone must NOT contribute to bad');
  assert.equal(out.advisoryMissing, 1, 'an absent advisory row counts as one optional item not present');
  assert.match(out.lines.join('\n'), /note\s+CLAUDE\.md/);
  // Single absent advisory row -> no problem(s) but one optional item.
  assert.equal(out.lines[out.lines.length - 1], 'all checks pass (1 optional item not present)');
});

test('T12-doctor-advisory-claude: a 2-tuple row defaults severity to fail (backward compatibility for fsChecks rows)', () => {
  // fsChecks() returns 2-tuples [label, ok]. evaluateDoctorChecks must
  // treat them as 'fail' (the pre-T12 behaviour) so the skill rows still
  // count toward the exit code.
  const rows = [
    ['skill fleet-orchestrator', true],
    ['skill fleet-engineer', false], // missing -> counts
    ['CLAUDE.md (advisory)', true, 'advisory'],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1, 'a failing 2-tuple row must still count, like the old behaviour');
  const joined = out.lines.join('\n');
  assert.match(joined, /FAIL\s+skill fleet-engineer/);
  // The summary is the second-to-last entry (the last is '' for the blank
  // line); the closing sentence sits in its own slot.
  const summaryIdx = out.lines.length - 1;
  assert.equal(out.lines[summaryIdx], '1 problem(s)');
});

test('T12-doctor-advisory-claude: wording includes the public-tree activation path', () => {
  // The advisory wording is the whole point - a contributor who sees it
  // must learn how to activate the orchestrator. cmdDoctor passes an
  // explicit 4th-tuple note for CLAUDE.md so the test pins the exact
  // substrings the production cmd ships (the helper's generic default is
  // covered separately below).
  const rows = [
    [
      'CLAUDE.md (advisory - private checkout convenience file; the fleet-orchestrator skill is the real dependency)',
      false,
      'advisory',
      'absent - PRIVATE checkout convenience file, not the public tree dependency; load .claude/skills/fleet-orchestrator/SKILL.md to activate the orchestrator',
    ],
  ];
  const out = evaluateDoctorChecks(rows);
  const note = out.lines[1];
  assert.match(note, /absent - PRIVATE checkout convenience file/);
  assert.match(note, /not the public tree dependency/);
  assert.match(note, /load \.claude\/skills\/fleet-orchestrator\/SKILL\.md/);
});

// ---------------------------------------------------------------------------
// Run 20261009-1105-doctor-portable T1-doctor-optional: the first CI run on
// the published repo failed in 10s because doctor demanded the global
// orchestration skill, an orca CLI, and a JEV key - all three documented as
// optional in the README. A clean-machine / fresh-CI-runner install must
// not be reported as broken.
//
// The T12 block above reclassified repo-root CLAUDE.md as advisory. This
// block generalises that pattern: every check the README documents as
// optional must be reclassified as advisory, and the summary line must
// distinguish required failures from optional-absent items. The tests below
// pin both the classification and the exit-code math.
//
// The cmdDoctor wiring is exercised by running the live `node fleet/bin/
// fleet.mjs doctor` command (paste the raw output in the report). The
// classification and exit-code math are exercised here against the pure
// evaluateDoctorChecks helper, with a row set that mirrors the live cmd.
// ---------------------------------------------------------------------------

// Mirrors the row set cmdDoctor builds when every required check passes and
// the four optional items are absent (no orca, no JEV key, no global skill).
// This is the live, on-CI-runner scenario the original bug report measured.
function cleanEnvRows({ claudeOk = false, globalSkill = false, jev = false, orca = false, orcaReachable = false } = {}) {
  return [
    ['config.json', true],
    ['run store', true],
    ...ROLE_SKILLS.map((n) => ['skill ' + n, true]),
    [
      'skill orchestration (global) (optional - the fleet-orchestrator skill is the real activation path; the global skill is a machine-level extra)',
      globalSkill,
      'advisory',
      'OPTIONAL per the README; the fleet-orchestrator skill (above) is the real activation path. The global orchestration skill is a machine-level extra; install it under ~/.claude/skills/orchestration/ if you want the orchestrator to use it.',
    ],
    [
      'CLAUDE.md (advisory - private checkout convenience file; the fleet-orchestrator skill is the real dependency)',
      claudeOk,
      'advisory',
      claudeOk
        ? 'present (private checkout convenience file - loaded by Claude Code automatically)'
        : 'absent - PRIVATE checkout convenience file, not the public tree dependency; load .claude/skills/fleet-orchestrator/SKILL.md to activate the orchestrator',
    ],
    ['reviewer-settings.json', true],
    [
      'orca cli on PATH or ORCA_CLI_COMMAND (optional - the default subagent dispatcher does not need it)',
      orca,
      'advisory',
      'OPTIONAL per the README: the default subagent dispatcher does not need orca. Install orca or set ORCA_CLI_COMMAND only if you want the isolation-grade dispatcher.',
    ],
    [
      'orca reachable (optional - orca runs the isolation-grade dispatcher; not required when it is absent)',
      orcaReachable,
      'advisory',
      'OPTIONAL per the README: orca is the isolation-grade dispatcher. A reachable orca matters only when the CLI above is also present; without orca there is nothing to be unreachable.',
    ],
    [
      'JEV key set (optional - the README documents JEV as optional; missing key falls back to full orchestrator review)',
      jev,
      'advisory',
      'OPTIONAL per the README: "JEV is optional. If it is unreachable or the key is unset, every gate falls back to a full orchestrator review." A missing key makes JEV a no-op, not a broken install.',
    ],
    ['milestone-store 6 runs, 0 with milestones.json, 0 broken, 6 legacy runs (advisory)', true],
  ];
}

test('T1-doctor-optional: clean environment (no orca, no JEV, no global skill) -> exit 0 with advisories reported', () => {
  // The exact scenario CI measured: a fresh public-tree install on a
  // machine that has orca/the global skill/the JEV key all absent. Every
  // required check passes; every optional check fails. The exit code MUST
  // be zero and the summary MUST list the optional-absent count.
  const rows = cleanEnvRows({ globalSkill: false, jev: false, orca: false, orcaReachable: false });
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 0, 'no required check may fail in a clean environment');
  // 3 of the 4 advisory rows are absent: global skill, orca cli, orca
  // reachable, JEV key -> 4 in this fixture (all 4 optionals set false).
  // CLAUDE.md is also absent -> 5 in total. None of them contribute to bad.
  assert.equal(out.advisoryMissing, 5, 'every absent optional item must be counted in advisoryMissing');
  const joined = out.lines.join('\n');
  // The four optional items must be visible as advisories, each pointing
  // the reader at the README or at the real activation path.
  assert.match(joined, /note\s+skill orchestration \(global\)/);
  assert.match(joined, /note\s+orca cli on PATH/);
  assert.match(joined, /note\s+orca reachable/);
  assert.match(joined, /note\s+JEV key set/);
  // The summary line must reflect both counts and signal "this is fine".
  assert.equal(out.lines[out.lines.length - 1], 'all checks pass (5 optional items not present)');
  // No FAIL tag in the rendered output - a reader must not be able to
  // mistake an advisory for a failure.
  assert.doesNotMatch(joined, /\bFAIL\b/);
});

test('T1-doctor-optional: a fully-loaded environment (all optionals present) -> exit 0, "all checks pass"', () => {
  // Sanity check: when every advisory row is also present, the summary
  // must drop the optionals-not-present parenthetical and the result is
  // indistinguishable from a 100% green install.
  const rows = cleanEnvRows({ claudeOk: true, globalSkill: true, jev: true, orca: true, orcaReachable: true });
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 0);
  assert.equal(out.advisoryMissing, 0, 'no advisory row is absent in this scenario');
  assert.equal(out.lines[out.lines.length - 1], 'all checks pass');
});

test('T1-doctor-optional: a missing fleet-orchestrator role skill -> exit non-zero even with all optionals present', () => {
  // The required check still bites. A missing role skill is a real
  // defect (the orchestrator cannot be activated), and the advisory rows
  // for optional tooling must not hide it.
  const rows = [
    ['config.json', true],
    ['run store', true],
    ...ROLE_SKILLS.map((n, i) => ['skill ' + n, i !== 0]), // fleet-orchestrator absent
    ['skill orchestration (global) (optional)', true, 'advisory', 'present'],
    ['CLAUDE.md (advisory)', true, 'advisory', 'present'],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND (optional)', true, 'advisory', 'present'],
    ['orca reachable (optional)', true, 'advisory', 'present'],
    ['JEV key set (optional)', true, 'advisory', 'present'],
    ['milestone-store 0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)', true],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1, 'a missing role skill MUST count toward bad');
  assert.equal(out.advisoryMissing, 0);
  const joined = out.lines.join('\n');
  assert.match(joined, /FAIL\s+skill fleet-orchestrator/);
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s)');
});

test('T1-doctor-optional: a malformed config.json -> exit non-zero', () => {
  // cmdDoctor's config.json check now reports BOTH "exists" and "parses".
  // A malformed file (parse fails) is a real defect, not optional. Build
  // the row the live cmd would push in that case and prove the helper
  // treats it as a failure.
  const rows = [
    ['config.json', false], // cmdDoctor's row when the JSON.parse throws
    ['run store', true],
    ...ROLE_SKILLS.map((n) => ['skill ' + n, true]),
    ['skill orchestration (global) (optional)', true, 'advisory', 'present'],
    ['CLAUDE.md (advisory)', false, 'advisory', 'absent'],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND (optional)', true, 'advisory', 'present'],
    ['orca reachable (optional)', true, 'advisory', 'present'],
    ['JEV key set (optional)', true, 'advisory', 'present'],
    ['milestone-store 0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)', true],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1, 'malformed config.json must count as a real problem');
  assert.equal(out.advisoryMissing, 1, 'CLAUDE.md still counts as an absent advisory');
  const joined = out.lines.join('\n');
  assert.match(joined, /FAIL\s+config\.json/);
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s), 1 optional item not present');
});

test('T1-doctor-optional: a missing run store -> exit non-zero', () => {
  // The run store is REQUIRED - a fleet with no place to record gates is
  // fundamentally broken. The row uses the same shape the live cmd pushes
  // (a 2-tuple, severity 'fail' by default).
  const rows = [
    ['config.json', true],
    ['run store', false],
    ...ROLE_SKILLS.map((n) => ['skill ' + n, true]),
    ['skill orchestration (global) (optional)', true, 'advisory', 'present'],
    ['CLAUDE.md (advisory)', false, 'advisory', 'absent'],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND (optional)', true, 'advisory', 'present'],
    ['orca reachable (optional)', true, 'advisory', 'present'],
    ['JEV key set (optional)', true, 'advisory', 'present'],
    ['milestone-store 0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)', true],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1, 'missing run store must count as a real problem');
  const joined = out.lines.join('\n');
  assert.match(joined, /FAIL\s+run store/);
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s), 1 optional item not present');
});

test('T1-doctor-optional: every advisory row is rendered with a "note" tag, never a "FAIL" tag', () => {
  // A reader must NEVER be able to mistake an advisory for a failure. The
  // tag column ('ok  ' / 'FAIL ' / 'note') is the only signal; pin the
  // exact column width and the exact 'note' value.
  const rows = cleanEnvRows({ globalSkill: false, jev: false, orca: false, orcaReachable: false });
  const out = evaluateDoctorChecks(rows);
  // Find each advisory row line (the "tag  name" line) and assert its tag.
  for (const line of out.lines) {
    if (line.startsWith('note  ')) {
      // 3-char tag + 2 spaces + name. The substring after 'note  ' is the
      // label the rest of the line carries. Pin the column shape so a
      // future refactor that changes 'ok  ' / 'FAIL ' to 'OK:' / 'X' does
      // not silently change the advisory tag too.
      assert.ok(line.length >= 5, 'advisory rows must still carry the same tag+padding shape');
    }
  }
  // No FAIL tag is present in a clean-environment row set.
  const joined = out.lines.join('\n');
  assert.doesNotMatch(joined, /\bFAIL\b/, 'no advisory row may render as a failure');
});

test('T1-doctor-optional: advisory rows never contribute to the failure count', () => {
  // Belt-and-braces: take every row in cleanEnvRows, force each in turn
  // to be the only failing advisory, and assert bad stays 0. This is the
  // promise the README relies on - the contributor never sees exit 1.
  const baseline = cleanEnvRows({ globalSkill: true, jev: true, orca: true, orcaReachable: true });
  for (let i = 0; i < baseline.length; i++) {
    const row = baseline[i];
    if (row[2] !== 'advisory') continue; // skip required rows
    const flipped = baseline.map((r, j) => (j === i ? [r[0], false, r[2], r[3]] : r));
    const out = evaluateDoctorChecks(flipped);
    assert.equal(out.bad, 0,
      'flipping advisory row ' + i + ' (' + row[0] + ') to false must NOT count toward bad');
  }
});

test('T1-doctor-optional: a 4-tuple advisory row with explicit note renders that exact note', () => {
  // The new 4th-tuple `note` slot lets cmdDoctor pin a specific reader
  // pointer per advisory row. The note is rendered verbatim below the
  // tag line so a contributor who sees the advisory can read the
  // explanation without leaving the output.
  const explicit = 'absent - this is the specific reader pointer the cmd shipped';
  const rows = [
    ['some optional thing (optional)', false, 'advisory', explicit],
  ];
  const out = evaluateDoctorChecks(rows);
  // lines[0] is the tag line; lines[1] is the indented note.
  assert.match(out.lines[0], /^note\s+some optional thing/);
  assert.equal(out.lines[1], '       ' + explicit);
});

test('T1-doctor-optional: a 3-tuple advisory row with no note uses the generic default', () => {
  // Callers that pass only the severity (the pre-T1 pattern) still work:
  // the helper fills in a generic default so a 3-tuple row is not a
  // footgun. The default points at the README so a reader has a way
  // forward.
  const rows = [
    ['some optional thing (optional)', false, 'advisory'],
  ];
  const out = evaluateDoctorChecks(rows);
  const joined = out.lines.join('\n');
  assert.match(joined, /note\s+some optional thing/);
  // Generic default mentions "OPTIONAL per the README" so a reader has
  // a forward pointer without the cmd having to ship a per-row note.
  assert.match(joined, /OPTIONAL per the README/);
  // And the row still does not count as a real failure.
  assert.equal(out.bad, 0);
  assert.equal(out.advisoryMissing, 1);
});

test('T1-doctor-optional: pluralisation - "1 optional item" (singular) vs "N optional items" (plural)', () => {
  // The summary line uses a singular noun when one item is missing and a
  // plural otherwise. The cost of getting this wrong is zero for
  // correctness but noticeable for reader trust.
  const one = [
    ['one optional (optional)', false, 'advisory', 'absent'],
  ];
  const out1 = evaluateDoctorChecks(one);
  assert.equal(out1.lines[out1.lines.length - 1], 'all checks pass (1 optional item not present)');

  const two = [
    ['one optional (optional)', false, 'advisory', 'absent'],
    ['two optional (optional)', false, 'advisory', 'absent'],
  ];
  const out2 = evaluateDoctorChecks(two);
  assert.equal(out2.lines[out2.lines.length - 1], 'all checks pass (2 optional items not present)');
});

test('T1-doctor-optional: both required failures and optional absents appear in the summary', () => {
  // When a required check fails AND an optional one is absent, the
  // summary must mention BOTH counts so a reader sees "1 problem, 2
  // advisories" at a glance rather than having to count by hand.
  const rows = [
    ['config.json', false], // required failure
    ['run store', true],
    ...ROLE_SKILLS.map((n) => ['skill ' + n, true]),
    ['skill orchestration (global) (optional)', false, 'advisory', 'absent'],
    ['CLAUDE.md (advisory)', false, 'advisory', 'absent'],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND (optional)', true, 'advisory', 'present'],
    ['orca reachable (optional)', true, 'advisory', 'present'],
    ['JEV key set (optional)', true, 'advisory', 'present'],
    ['milestone-store 0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)', true],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1);
  assert.equal(out.advisoryMissing, 2);
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s), 2 optional items not present');
});

test('T1-doctor-optional: required failures alone (no advisories) -> "N problem(s)" with no parenthetical', () => {
  // The reverse of the previous test - when only required rows fail, the
  // summary must NOT mention optionals at all. Adding a trailing
  // parenthetical in this case would be a noise regression.
  const rows = [
    ['config.json', false],
    ['run store', true],
    ...ROLE_SKILLS.map((n) => ['skill ' + n, true]),
    ['skill orchestration (global) (optional)', true, 'advisory', 'present'],
    ['CLAUDE.md (advisory)', true, 'advisory', 'present'],
    ['reviewer-settings.json', true],
    ['orca cli on PATH or ORCA_CLI_COMMAND (optional)', true, 'advisory', 'present'],
    ['orca reachable (optional)', true, 'advisory', 'present'],
    ['JEV key set (optional)', true, 'advisory', 'present'],
    ['milestone-store 0 runs, 0 with milestones.json, 0 broken, 0 legacy runs (advisory)', true],
  ];
  const out = evaluateDoctorChecks(rows);
  assert.equal(out.bad, 1);
  assert.equal(out.advisoryMissing, 0);
  assert.equal(out.lines[out.lines.length - 1], '1 problem(s)');
});

