# eng-1 report — add hello.mjs run counter

## Files changed

- `fleet/bin/hello.mjs` (new) — Node ESM script. Exposes `countRunDirs(runsDirPath)` and prints `runs: <n>` to stdout when run directly. Paths resolve relative to the script location (repo root = `dirname(dirname(here))`), not the process cwd. Returns 0 when `fleet/runs/` does not exist.
- `fleet/bin/hello.test.mjs` (new) — `node:test` + `node:assert/strict`. 4 tests, zero dependencies.

## Commit

- sha: `ffb9fa60e321d4b91b274f6e94bba90f3d912ce8`
- message: `fleet 20261003-2245-hello-runcount/eng-1: add hello.mjs run counter`

## Acceptance #1 — `node fleet/bin/hello.mjs`

```
runs: 1
```

EXITCODE=0

The single line `runs: 1` corresponds to the one existing run directory `20261003-2245-hello-runcount/` (plus the `.gitkeep` file is not a directory, so it is not counted).

## Acceptance #2 — `node --test fleet/bin/hello.test.mjs`

```
runs: 1
✔ countRunDirs returns 0 when the runs directory does not exist (5.2888ms)
✔ countRunDirs counts immediate subdirectories only (9.8686ms)
✔ countRunDirs returns 0 for an empty runs directory (1.807ms)
✔ hello.mjs prints "runs: <n>" as a single line and resolves paths relative to repo root (201.7949ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 488.6926
```

EXITCODE=0

### Zero-run coverage

The zero case is covered by three distinct tests:

1. `countRunDirs returns 0 when the runs directory does not exist` — uses a missing path under a temp dir to exercise the `ENOENT` branch.
2. `countRunDirs returns 0 for an empty runs directory` — uses an existing-but-empty temp dir.
3. `hello.mjs prints "runs: <n>" as a single line and resolves paths relative to repo root` — runs the actual CLI with `cwd: tmpdir()` to prove the script ignores process cwd and resolves via `import.meta.url`.

The third test also verifies exactly-one-line stdout output (`assert.match(lines[0], /^runs: \d+$/)` + `assert.equal(lines[1], '')`).

## What I did NOT do

- Did not touch any file outside the two listed in TARGET.
- Did not touch `fleet/runs/` contents (did not modify or remove `.gitkeep`, the run directory, or its `reports/` subdir).
- Did not push the commit.
- Did not amend history.
- Did not stage any of the pre-existing untracked files in the repo (`../../.claude/`, `Hermes/`, `ganz-command-center/`, etc.). Only the two files in `fleet/bin/` were staged.
- Did not add any dependencies; both files use standard library only (`node:fs`, `node:path`, `node:url`, `node:test`, `node:assert/strict`, `node:child_process`, `node:os`).