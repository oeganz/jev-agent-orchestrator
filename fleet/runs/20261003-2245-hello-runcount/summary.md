# Run summary — 20261003-2245-hello-runcount

**Objective:** add `fleet/bin/hello.mjs` printing the count of run directories.
**Status:** completed. **Orca Run:** run_054c65bfda51. **Model:** inherited (sonnet-tier), 15.8 rule 3.

## Tasks

| task | role | outcome | evidence |
|---|---|---|---|
| eng-1 | engineer | succeeded | commit `ffb9fa6`, 2 files, +81 lines, exactly the authorized files |
| test-1 | tester (fresh terminal) | verified | re-ran everything independently; named its one unexercised edge |

## Gates

| gate | orchestrator (authoritative) | JEV shadow | agreement |
|---|---|---|---|
| G2 build | accept | rework (max_flag 0.68) | **no** |
| G3 verify | accept | accept (max_flag 0.50) | yes |

## What the run proved (the point of v0)

1. **base_sha discipline works.** Both task rows carry base_sha; G2's diff was
   computed by the orchestrator from `base_sha..HEAD`, not self-reported. The
   worker had no opportunity to shape its own review evidence.
2. **Fresh-terminal testing works.** The tester was dispatched without
   `--terminal`, inherited nothing, re-ran every command, and produced the
   mandatory did-NOT-verify section (the symlink edge it could not exercise).
3. **Shadow mode works.** JEV's false positive at G2 did not break the run -
   the orchestrator verdict stood, and the disagreement was recorded. This is
   exactly why v0 gates are orchestrator-authoritative.
4. **The run ended with zero reclaimable workers** (both released).

## The finding: raw output, not summaries

Same task, same code, two gate states:

| state | tests_missing flag | JEV verdict | correct? |
|---|---|---|---|
| G2: test output SUMMARISED ("4 tests, 4 pass") | **0.68** | rework | **false positive** |
| G3: test output pasted RAW | **0.03** | accept | correct |

The only variable is whether the raw command output was included. A summary
reads as "no output shown" to the tests_missing question. **Rule: the gate state
must carry raw command output.** This is a live confirmation of benchmark
finding 4 (tests_missing conflates absent-vs-summarised) and is now a concrete
assembly requirement, not a suspicion.

Caveat: even at G3, max_flag was 0.50 against a 0.55 threshold, with
evidence_gap drifting 0.30 -> 0.50. The clean case sits uncomfortably close to
the flag line. Thresholds tuned on 12 synthetic cases need real-run data before
they are trusted.

## Gaps this run did NOT cover

- No defect was planted, so no gate should have failed - this is a happy-path
  run. Whether the loop catches a real defect end-to-end is still untested.
- n=1. One clean task, one JEV disagreement, no repetition.
- No rework loop was exercised (no task was sent back).
- Orchestrator was this session, not a cold pane reading CLAUDE.md.
