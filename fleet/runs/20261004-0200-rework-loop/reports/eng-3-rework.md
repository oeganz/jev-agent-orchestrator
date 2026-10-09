# eng-3-rework report

Run: 20261004-0200-rework-loop · Task: task_670a108c582f · Base commit: bcd291f
Gate finding addressed: acceptance criterion 3 — `--dir` with no following value fell back silently to the default instead of failing.

## Files changed

- `fleet/bin/count.mjs` — `--dir` with no following value now writes `error: --dir requires a value` to stderr and exits 2; no fallback.
- `fleet/bin/count.test.mjs` — replaced the fallback-asserting test with one asserting non-zero exit AND non-empty stderr.

## Commit

`57f7bc18e2ba803a3d794492d46a4b6004b311bd`
Message: `fleet 20261004-0200-rework-loop/eng-3-rework: fail fast on --dir without a value`
One commit, no amend, not pushed.

## Evidence — gate command BEFORE the fix (raw)

Command: `node fleet/bin/count.mjs --dir` (cwd: Agent/Orchestrator)

```
BEFORE FIX (node fleet/bin/count.mjs --dir)
exit=0
--- stdout ---
runs: 3
--- stderr ---

```

This reproduces the gate finding verbatim: exit 0, silent fallback.

## Evidence — TDD red: restored test fails against unfixed code (raw)

Command: `node --test fleet/bin/count.test.mjs` (cwd: Agent/Orchestrator)

```
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 931.631

✖ failing tests:

test at fleet\bin\count.test.mjs:91:1
✖ count.mjs with --dir and no value fails: non-zero exit and an error on stderr (207.9554ms)
  AssertionError [ERR_ASSERTION]: expected non-zero exit, got 0
      at TestContext.<anonymous> (file:///<repo>/Agent/Orchestrator/fleet/bin/count.test.mjs:95:10)
      at TestContext.<anonymous> (file:///<repo>/Agent/Orchestrator/fleet/bin/count.test.mjs:95:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1397:25)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.processPendingSubtests (node:internal/test_runner/test:969:18)
      at Test.run (node:internal/test_runner/test:1462:12)
      at Test.processPendingSubtests (node:internal/test_runner/test:969:18)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1397:25)
      at Test.postRun (node:internal/test_runner/test:7015:19)
      at Test.run (node:internal/test_runner/test:1462:12) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 0,
    operator: 'notStrictEqual',
    diff: 'simple'
  }
```

(The stack-frame repetition above is as captured from the tail of the run; the substance is the assertion: expected non-zero exit, got 0.)

## Evidence — gate command AFTER the fix (raw)

Command: `node fleet/bin/count.mjs --dir` (cwd: Agent/Orchestrator)

```
=== AC1: --dir with no value ===
exit=2
--- stdout ---

--- stderr ---
error: --dir requires a value
```

## Evidence — acceptance criteria (raw)

AC1 — `node fleet/bin/count.mjs --dir`: exit 2, stderr `error: --dir requires a value` (above).

AC2 — `node fleet/bin/count.mjs`:

```
=== AC2: default ===
runs: 3
exit=0
```

AC3 — `node fleet/bin/count.mjs --dir <path>` against a temp dir containing r1, r2:

```
=== AC3: --dir <path> ===
runs: 2
exit=0
```

AC4 — full suite, `node --test fleet/bin/count.test.mjs`:

```
runs: 3
✔ countRunDirs returns 0 when the runs directory does not exist (5.4054ms)
✔ countRunDirs counts immediate subdirectories only (10.0618ms)
✔ countRunDirs does not count files at the runs root (only directories) (7.4828ms)
✔ countRunDirs returns 0 for an empty runs directory (1.7767ms)
✔ count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location (206.1279ms)
✔ count.mjs with --dir <path> counts run directories under that path (215.6241ms)
✔ count.mjs with --dir and no value fails: non-zero exit and an error on stderr (195.2628ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 959.4806
```

7/7 pass, including the restored failure test. Unlike the rejected attempt, this suite's green is trustworthy here: the red run above shows the restored test actually discriminates.

## What I did NOT do

- Did not fix a pre-existing, out-of-spec observation: `count.mjs` runs its CLI block on import, so the test suite output shows a stray `runs: 3` line at the top (the `import { countRunDirs } from './count.mjs'` executes module-level code). This predates bcd291f's shape and is not part of any acceptance criterion; fixing it means guarding the CLI block behind an import-meta check, which is a scope expansion beyond the spec's two edits. Flagging for the orchestrator to decide.
- Did not amend, did not push, did not commit anything besides the two files in the single specified commit (the report file itself is intentionally uncommitted).
- Did not change the exit code to any specific value other than 2 — the spec required non-zero; 2 was chosen as a conventional argument-error code.

## Process note

One transient tooling artifact during reproduction: an initial capture ran from the repo root (wrong cwd), producing `Cannot find module 'C:\AI\<vault>\fleet\bin\count.mjs'`. That was my shell's working directory, not repo behavior; the evidence above is from the correct cwd and matches the gate finding exactly.
