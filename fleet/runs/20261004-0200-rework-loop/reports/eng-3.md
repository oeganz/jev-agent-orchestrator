# eng-3 report — add `--dir` flag to count.mjs

## Files changed
- `Agent/Orchestrator/fleet/bin/count.mjs` — added minimal argv parser; honours `--dir <path>`; on `--dir` with no value writes an error to stderr and exits with code 1 (no silent fallback to the default).
- `Agent/Orchestrator/fleet/bin/count.test.mjs` — added two tests for the new flag (one for the happy path, one for the no-value error path).

No other files were touched.

## Commit SHA
`9303b6da7b0a5464f4de4d85b14111f013b325c3`

```
fleet 20261004-0200-rework-loop/eng-3: add --dir flag to count.mjs
```

## Raw acceptance output

### Acceptance 1 — default behaviour preserved

```
$ node fleet/bin/count.mjs
runs: 3
exit=0
```

### Acceptance 2 — `--dir <path>` counts that directory

A throwaway `/tmp/acc-test-run/` with four subdirectories was created for this run.

```
$ node fleet/bin/count.mjs --dir /tmp/acc-test-run
runs: 4
exit=0
```

### Acceptance 3 — `--dir` with no value exits non-zero and writes to stderr

```
$ node fleet/bin/count.mjs --dir
error: --dir requires a path argument
exit=1
```

## Raw test output

```
$ node --test fleet/bin/count.test.mjs
runs: 3
✔ countRunDirs returns 0 when the runs directory does not exist (4.119ms)
✔ countRunDirs counts immediate subdirectories only (10.2964ms)
✔ countRunDirs does not count files at the runs root (only directories) (6.4748ms)
✔ countRunDirs returns 0 for an empty runs directory (1.798ms)
✔ count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location (197.8097ms)
✔ count.mjs with --dir <path> counts run directories under that path (194.1862ms)
✔ count.mjs with --dir and no value exits non-zero and prints an error to stderr (193.8591ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 878.4611
```

(The leading `runs: 3` line is the top-level stdout of `count.mjs` itself — `count.test.mjs` imports `count.mjs`, which executes its body once. This matches the pre-existing pattern that the original test was already tolerating.)

## Notes on the TDD flow

The first draft of the `--dir <path>` test used 3 subdirectories, which coincidentally matched the existing count of `fleet/runs` (3 entries). It would have falsely passed even before the implementation landed. The test was rewritten to use 5 subdirectories to make it a genuine red-then-green test, and the rewritten test was observed failing against the un-modified `count.mjs` before the implementation was added. The final committed test uses 5 subdirectories.

## Things I did NOT do
- I did not modify any file outside `Agent/Orchestrator/fleet/bin/count.mjs` and `Agent/Orchestrator/fleet/bin/count.test.mjs` (per the Ownership constraint).
- I did not push the commit (per the commit rule).
- I did not amend history.
- I did not add any dependencies; the change is pure Node stdlib (`node:fs`, `node:path`, `node:url`).
- I did not silently fall back to the default runs directory when `--dir` was passed without a value — the error case exits non-zero with a stderr message, as required.