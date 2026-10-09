# eng-2 REWORK: count.mjs run-directory counter (closes G2 REWORK)

Trigger: `reports/g2-independent.md` VERDICT: REWORK (gate g2-reviewer, 2026-10-03T17:39:36Z).
Base for this rework: `91446a8` (HEAD after the defect-hunt summary commit).

Note: the defect under rework was an INTENTIONAL orchestrator plant (run.json
`planted_defect`). This rework closes the run's stated uncovered gap --
"the rework path itself (the loop did not dispatch a fix and re-verify)" --
by applying the G2-required fix and re-verifying with raw evidence.

## Files changed

- `Agent/Orchestrator/fleet/bin/count.mjs` (1 line: filter on `e.isDirectory()`)
- `Agent/Orchestrator/fleet/bin/count.test.mjs` (2 assertions corrected)

## Commit

- SHA: `bd6ae41`
- Message: `fleet 20261003-2310-defect-hunt/eng-2: count only directories in countRunDirs`
- Scope: 2 files changed, 4 insertions(+), 4 deletions(-). No other file staged.

## Diff

```
-      n++;
+      if (e.isDirectory()) n++;
...
-    assert.equal(countRunDirs(tmp), 4);
+    assert.equal(countRunDirs(tmp), 3);
...
-    writeFileSync(join(tmp, 'one', 'stray.txt'), '');
-    writeFileSync(join(tmp, 'one', '.gitkeep'), '');
+    writeFileSync(join(tmp, '.gitkeep'), '');
+    writeFileSync(join(tmp, 'stray.txt'), '');
```

## TDD -- RED first (corrected tests vs buggy impl)

Command: `node --test fleet/bin/count.test.mjs` (before the count.mjs fix)

```
FAIL countRunDirs counts immediate subdirectories only          (4 !== 3)
FAIL countRunDirs does not count files at the runs root (only directories)  (3 !== 1)
tests 5   pass 3   fail 2
EXIT:1
```

The two corrected tests genuinely fail against the buggy code -- proving they now
exercise Criterion 3 (unlike the vacuous shipped suite).

## GREEN -- after the fix

Command: `node --test fleet/bin/count.test.mjs`

```
runs: 2
PASS countRunDirs returns 0 when the runs directory does not exist (5.5412ms)
PASS countRunDirs counts immediate subdirectories only (10.5859ms)
PASS countRunDirs does not count files at the runs root (only directories) (6.8974ms)
PASS countRunDirs returns 0 for an empty runs directory (1.7459ms)
PASS count.mjs prints "runs: <n>" as a single line and resolves paths relative to script location (200.3532ms)
tests 5
suites 0
pass 5
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 456.3722
EXIT:0
```

(The leading `runs: 2` line is the module top-level side effect on import -- the
same pattern as hello.mjs; it does not affect exit code or results.)

## Acceptance commands

`node fleet/bin/count.mjs`

```
runs: 2
EXIT:0
```

`fleet/runs/` inventory: 2 directories (`20261003-2245-hello-runcount`,
`20261003-2310-defect-hunt`) plus 1 file (`.gitkeep`) at the root. n = 2. CORRECT.
Before the fix the same command printed `runs: 3` (the `.gitkeep` counted).

## Independent edge probe (exported countRunDirs)

2 dirs + 2 files at the counted root:

```
root entries: run-a(dir), run-b(dir), NOT-A-RUN.txt(file), .gitkeep(file)
expected (dirs only): 2
countRunDirs returned: 2
EXIT:0
```

Before the fix this returned 4. Now 2.

## What I did NOT do

- Did not touch `hello.mjs` / `hello.test.mjs` (outside Ownership).
- Did not edit `gates.jsonl`, `run.json`, or `summary.md` -- those are the
  orchestrator's artifacts; the rework gate row is the orchestrator's to record.
- Did not stage or commit the pre-existing untracked directories at the repo
  root (`.claude/`, `Company/`, etc.) -- only the two owned files.
- Did not amend history or push.
- Did not remove the top-level `process.stdout.write` side effect from count.mjs
  (matches the sibling hello.mjs and is not part of the rework scope).
