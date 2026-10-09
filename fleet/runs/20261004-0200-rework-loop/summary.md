# Run summary — 20261004-0200-rework-loop

**Objective:** exercise the REWORK branch — the last untested path. Gate returns
REWORK, orchestrator dispatches a fix citing the failing evidence, re-verify.
**Answer: the branch works end-to-end.** **Orca Run:** run_ce7ab03a2625.

## Sequence

| step | task | outcome |
|---|---|---|
| 1 | eng-3 | implemented `--dir` flag, 7/7 tests - looked clean |
| 2 | (plant) | `--dir` with no value made to fall back silently; covering test rewritten to assert the fallback. Suite green 7/7. |
| 3 | G2 gate | **REWORK** - C3 not met: `--dir` gave `runs: 3`, exit 0, empty stderr |
| 4 | eng-3-rework | dispatched WITH the gate's failing evidence; fixed code + restored the test |
| 5 | G2 re-verify | **accept** - exit 2 + stderr message; C1/C2 regression-checked; 7/7 |
| 6 | test-3 | fresh terminal; **verified**, modified nothing, stated its gaps |
| 7 | G3 | accept |
| 8 | settle | 3 terminals released |

## What this proves

1. **The rework branch closes.** The gate's failing evidence was carried into the
   fix spec verbatim, the engineer fixed exactly that, and re-verification passed.
   This is the branch that was never exercised in the defect-hunt run.
2. **The rework spec must carry the EVIDENCE, not a summary.** The fix landed
   first try because the spec quoted the observed command, stdout, stderr and exit
   code. Same lesson as 14.12b (raw, not summarised) - now confirmed for dispatches.
3. **A green suite was again misleading.** The plant produced 7/7 green while
   violating acceptance criterion 3. Detection came from running the criterion,
   not from the tests. Third independent occurrence of this pattern.
4. **The tester earned its place.** It found a real new edge the engineer missed:
   `--dir=path` (equals form) is silently ignored and falls back to the default -
   the same silent-misparse class as the defect just fixed. It judged it
   non-blocking (not in the acceptance criteria) and said so, which is correct.

## Follow-ups recorded, not actioned

- `--dir=path` equals form: silently ignored, exit 0. Same class as the fixed bug.
  Neither in the acceptance criteria nor in the gate's scope, so it did not fail
  the gate - but it is a real rough edge.
- The tester also flagged probes A (silent misparse) as a rough edge.

## Not covered

- n=1 rework cycle. One defect, one fix, one re-verify.
- No second rework (the loop was not driven to its retry limit).
- JEV stayed advisory throughout - its authority path remains unexercised.
