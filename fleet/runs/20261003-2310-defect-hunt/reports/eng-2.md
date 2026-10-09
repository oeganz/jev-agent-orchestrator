# eng-2: count.mjs run-directory counter

## Files changed
- `Agent/Orchestrator/fleet/bin/count.mjs` (new)
- `Agent/Orchestrator/fleet/bin/count.test.mjs` (new)

No other files were created, edited, or deleted.

## Commit
- SHA: `3cf77ace42a17983b7a032716b226a61feb4c7cd`
- Message: `fleet 20261003-2310-defect-hunt/eng-2: add count.mjs run-directory counter`
- Base: `f08f7061c54bf085ce777ac04aeeba0db7f53582`

## RAW output — `node fleet/bin/count.mjs`
```
runs: 2
```

## RAW output — `node --test fleet/bin/count.test.mjs`
```
runs: 2
✔ countRunDirs returns 0 when the runs directory does not exist (5.0407ms)
✔ countRunDirs counts immediate subdirectories only (9.8539ms)
✔ countRunDirs does not count files at the runs root (only directories) (5.9664ms)
✔ countRunDirs returns 0 for an empty runs directory (1.6324ms)
✔ count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location (190.3066ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 477.2013
EXIT:0
```

Note: the literal line `runs: 2` at the very top of the test output is emitted as a
side effect of `import { countRunDirs } from './count.mjs'`. The imported module
runs its top-level `process.stdout.write` once on load. This is the same pattern
as the sibling `hello.mjs`/`hello.test.mjs`; it does not affect exit code, test
results, or any of the three acceptance criteria.

## Acceptance mapping
1. **Script prints exactly "runs: <n>"** — confirmed. Output is `runs: 2`, a single
   line plus a trailing newline.
2. **`node --test fleet/bin/count.test.mjs` passes with raw output shown** —
   confirmed. 5/5 tests pass, exit code 0, full output above.
3. **Files at `fleet/runs/` root are NOT counted as runs; only directories count**
   — confirmed. The dedicated test `countRunDirs does not count files at the runs
   root (only directories)` asserts that a directory + 2 files (a plain file and a
   dotfile) yields a count of 1. The end-to-end test also exercises the live
   `fleet/runs/` (which currently holds 2 directories + `.gitkeep`), reporting 2.

## What I did NOT do
- Did not modify, delete, or rewrite `hello.mjs` or `hello.test.mjs`. They are
  outside this task's Ownership list and are used only as a reference for
  style/pattern.
- Did not add any npm dependency. Implementation is standard-library only
  (`node:fs`, `node:path`, `node:url`) — matches the "zero dependencies" constraint.
- Did not push the commit or amend history.
- Did not touch any other file under `Agent/Orchestrator/`, `fleet/`, or anywhere
  else in the repo.
- Did not strip the `runs: 2` side effect from `count.mjs` for the test
  runner. The sibling `hello.mjs` exhibits the same behavior and the spec does
  not forbid it; the test asserts the first line matches `^runs: \d+$` and the
  second line is empty (i.e. exactly one line) when the script is spawned in
  isolation via `spawnSync`, which is the contract that matters.
