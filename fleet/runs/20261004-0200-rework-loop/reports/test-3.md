# test-3 — Verification of eng-3-rework (count.mjs `--dir` fail-fast)

- Run: 20261004-0200-rework-loop
- Worker: TESTER (per fleet-tester skill; read/run only, no fixes)
- Commits examined: `bcd291f` (original eng-3), `57f7bc1` (eng-3-rework, HEAD)
- Verdict: **verified**

## Verdict

**verified** — all four acceptance criteria pass when run by me from the repo, and the
criterion-3 test is demonstrably a genuine failure assertion: run against the OLD
(`bcd291f`) count.mjs it fails with `AssertionError: expected non-zero exit, got 0`
(suite exit 1), so it cannot have been weakened to pass.

## Acceptance criteria — one by one

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | `node fleet/bin/count.mjs` prints exactly `runs: <n>` for fleet/runs/ | **met** | Output `runs: 3`, exit 0; ground truth = 3 subdirectories in `fleet/runs/` |
| 2 | `--dir <path>` counts that path | **met** | `--dir .../fleet/bench` → `runs: 3` (bench holds 3 dirs: `cases.mjs`… no — 3 subdirs, see raw output); `--dir .` from repo root → `runs: 3`, matching `find . -maxdepth 1 -type d` = 3 |
| 3 | `--dir` with NO value: error on stderr, NON-ZERO exit | **met** | Exit code **2**, stderr `error: --dir requires a value`, stdout empty |
| 4 | `node --test fleet/bin/count.test.mjs` passes | **met** | 7 tests, 7 pass, 0 fail, exit 0 |

## Criterion 3 — verified by actually running it

I captured exit code and stderr separately:

```
$ cd Agent/Orchestrator && node fleet/bin/count.mjs --dir 2>/tmp/c3-stderr.txt ; echo "EXIT=$?"
EXIT=2
---STDERR---
error: --dir requires a value
---STDOUT---
(empty)
```

## Counter-evidence: the criterion-3 test genuinely asserts failure

The old test (at `bcd291f`) was the weakened one — its diff confirms it asserted the
fallback (`assert.equal(result.status, 0)` + `startsWith('runs: ')`). The rework replaced
it with `assert.notEqual(result.status, 0)` + non-empty-stderr assertion.

To prove the new test is not vacuous, I materialized OLD count.mjs + NEW count.test.mjs
in an OS temp dir (no repo files touched) and ran the suite:

```
$ git show bcd291f:Agent/Orchestrator/fleet/bin/count.mjs > /tmp/counter-evidence/count.mjs
$ git show 57f7bc1:Agent/Orchestrator/fleet/bin/count.test.mjs > /tmp/counter-evidence/count.test.mjs
$ node --test count.test.mjs

✖ count.mjs with --dir and no value fails: non-zero exit and an error on stderr (211.016ms)
  AssertionError [ERR_ASSERTION]: expected non-zero exit, got 0
TRUE_SUITE_EXIT=1   (6 pass / 1 fail)
```

The new suite fails against the old code exactly on the criterion-3 test. The rework
did not misrepresent anything: commit `57f7bc1` touches only `count.mjs` (+8/−3 wait,
+5/−3) and `count.test.mjs` (+6/−3), and does what its message says.

## Edge probes (engineer not seen covering these)

| Probe | Command | Observed | Assessment |
|-------|---------|----------|------------|
| A: flag after flag | `node fleet/bin/count.mjs --dir --verbose` | `runs: 0`, exit 0, stderr empty | `--verbose` is consumed as the path value (readdir ENOENT → 0). Silent misparse, exit 0. |
| B: nonexistent path | `--dir C:/definitely/not/a/real/path-xyz` | `runs: 0`, exit 0 | Consistent with `countRunDirs` ENOENT→0 contract (also unit-tested). Defensible. |
| C: empty string | `--dir ""` | `runs: 0`, exit 0 | Empty path → ENOENT → 0. Silent, but not spec-breaking. |
| D: equals form | `node fleet/bin/count.mjs "--dir=/tmp/probe-d"` (probe-d holds 2 dirs) | `runs: 3` — the DEFAULT, exit 0 | **`--dir=path` is silently ignored**; the literal `--dir=path` token matches neither `'--dir'` nor a bare path, so the default runs dir is used with no error. |
| E: relative path | `--dir .` from repo root | `runs: 3`, matches ground truth | OK. |

Probes A and D are real rough edges (silent misparse / silent ignore, both exit 0), but
no acceptance criterion covers flag-parsing conventions beyond space-separated
`--dir <path>`, so they are observations, not gate failures. Reporting for the next
engineer task if desired: values starting with `--` (probe A) and the `=` form (probe D).

## Side observation

`count.mjs` executes its CLI top-level code (argv loop + stdout write) unconditionally
on import — visible as a stray `runs: 3` line at the top of the `node --test` output.
Harmless for the current tests, but any future importer of `countRunDirs` whose own
argv contains `--dir` would trigger CLI behavior (including the exit 2) at import time.
A main-module guard would remove the smell. Not a gate criterion; not fixed by me.

## Raw output of every command run

```
$ node fleet/bin/count.mjs ; echo "EXIT=$?"
runs: 3
EXIT=0

$ ls -1 fleet/runs/ && find fleet/runs -maxdepth 1 -mindepth 1 -type d | wc -l
20261003-2245-hello-runcount
20261003-2310-defect-hunt
20261004-0200-rework-loop
3

$ node fleet/bin/count.mjs --dir .../fleet/bench ; echo "EXIT=$?"; find fleet/bench -maxdepth 1 -mindepth 1 -type d | wc -l
runs: 3
EXIT=0
3

$ node fleet/bin/count.mjs --dir 2>/tmp/c3-stderr.txt ; echo "EXIT=$?"; cat /tmp/c3-stderr.txt
EXIT=2
error: --dir requires a value

$ node --test fleet/bin/count.test.mjs 2>&1; echo "EXIT=$?"
runs: 3
✔ countRunDirs returns 0 when the runs directory does not exist (6.285ms)
✔ countRunDirs counts immediate subdirectories only (15.1184ms)
✔ countRunDirs does not count files at the runs root (only directories) (11.2554ms)
✔ countRunDirs returns 0 for an empty runs directory (2.889ms)
✔ count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location (295.5284ms)
✔ count.mjs with --dir <path> counts run directories under that path (244.2087ms)
✔ count.mjs with --dir and no value fails: non-zero exit and an error on stderr (226.8791ms)
ℹ tests 7  ℹ pass 7  ℹ fail 0
EXIT=0

$ git log --oneline -4 -- fleet/bin/count.mjs fleet/bin/count.test.mjs
57f7bc1 fleet 20261004-0200-rework-loop/eng-3-rework: fail fast on --dir without a value
bcd291f fleet 20261004-0200-rework-loop/eng-3: add --dir flag to count.mjs
bd6ae41 fleet 20261003-2310-defect-hunt/eng-2: count only directories in countRunDirs
3cf77ac fleet 20261003-2310-defect-hunt/eng-2: add count.mjs run-directory counter

$ git diff bcd291f 57f7bc1 --stat
 Agent/Orchestrator/fleet/bin/count.mjs      | 8 +++++---
 Agent/Orchestrator/fleet/bin/count.test.mjs | 9 ++++++---

$ node fleet/bin/count.mjs --dir --verbose; echo "EXIT=$?"
runs: 0
EXIT=0

$ node fleet/bin/count.mjs --dir "C:/definitely/not/a/real/path-xyz"; echo "EXIT=$?"
runs: 0
EXIT=0

$ node fleet/bin/count.mjs --dir ""; echo "EXIT=$?"
runs: 0
EXIT=0

$ node fleet/bin/count.mjs "--dir=/tmp/probe-d"; echo "EXIT=$?"   # probe-d = 2 dirs; default = 3
runs: 3
EXIT=0

$ node fleet/bin/count.mjs --dir . ; echo "EXIT=$?"; find . -maxdepth 1 -mindepth 1 -type d | wc -l
runs: 3
EXIT=0
3

# counter-evidence (old code + new test, in /tmp/counter-evidence)
$ node --test count.test.mjs
✖ ... AssertionError [ERR_ASSERTION]: expected non-zero exit, got 0
TRUE_SUITE_EXIT=1  (6 pass / 1 fail)
```

## What I did NOT verify

- **`--dir` pointing at a regular file** (not a directory): `countRunDirs` re-throws
  non-ENOENT errors, so I expect an uncaught `ENOTDIR` stack trace and non-zero exit,
  but I did not run it.
- **Permission-denied directories** and Unicode/space-containing paths — untested.
- **Concurrent invocations** — untested (skill's example edge; low relevance here).
- **`--dir` appearing multiple times** on one command line — untested (last-one-wins
  by code reading; not observed by running it).
- **Other fleet scripts** (`hello.mjs`, `bench/*`) — out of scope for this spec.
- **Behavior under `--dir=path` and flag-after-flag beyond observation** — I verified
  only what they do today (see probes); no spec defines what they should do.
- I did not run any repo-wide test suite beyond `count.test.mjs`; the spec requires
  only that file.
