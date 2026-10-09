---
name: jev-scoring
description: Use when scoring, grading, reviewing, or gate-checking any artifact (a code change, worker report, plan, diff, or document) with JEV / TypeSafe System One, or when building noul, choice, or score questions, choosing auto-pass thresholds, or calling /v1/systemone.
---

# Scoring with JEV

JEV is a **calibrated decision model**, not a language model. It returns probabilities, never prose. Use it when a
judgement needs a *number you can threshold*, not a paragraph.

**Core principle: separate the robust signal from the compromiseable one, and let the robust one decide.**

## The API

`POST <systemone-endpoint>` (e.g. `https://<jev-host>.id/v1/systemone`), Bearer auth:

```json
{"model":"jev-1-13-free",
 "state":{"task":"...","report":"...","evidence":"..."},
 "questions":{
   "out_of_scope":{"type":"noul","instructions":"Does the change touch files the task did not authorise?"},
   "evidence_quality":{"type":"score","instructions":"How complete is the evidence?",
      "criteria":["None","Partial","Mostly complete","Complete"]},
   "route":{"type":"choice","instructions":"What should happen next?",
      "criteria":{"accept":"...","rework":"...","other":"None of these fit"}}}}
```

Response: `{ model, answers, usage }`.

**Two shapes that bite:**

1. **`score` criteria is an ARRAY; `choice` criteria is an OBJECT.** Object-form `score` is rejected upstream with a
   generic "provider rejected the request" - the primitive looks broken when only the shape is wrong.
2. **`noul` has no `confidence` field.** The probability IS the certainty. `choice`/`score` return one.

## Choosing the primitive

| Need | Primitive | Notes |
|---|---|---|
| Is X true? | `noul` | 0-1. **0.5 = equal odds, not "medium."** No bands inside it. |
| Which of N? | `choice` | Object criteria. **Always include a no-match option.** |
| How much, on a rubric? | `score` | Array criteria, 2-10 levels. Normalise by `len(criteria)-1`. |

Mix all three in ONE request - questions run in parallel and cannot contaminate each other.

## Gate scoring recipe

1. **Decompose: one narrow question per claim**, each phrased so `true` = a problem. Never ask "is this good?" alone.
2. **Put the signal FIRST in the state.** Measured: signal-first gave confidence 0.62, signal-last 0.19.
   **And paste RAW command output, never a summary.** Measured live: the SAME task at the same gate scored tests_missing 0.68 (policy: rework) when the test output was summarised as "4 tests, 4 pass", and 0.03 (correct) when the raw output was pasted. A summary reads as "no output shown" to the tests_missing question.
3. **Add one `choice`** for the route, with an abstain option.
4. **Keep the policy in code**, not in the questions - changing a threshold should be a number edit, not a re-wording.
5. **Persist raw distributions**, not just the verdict. Re-tuning then costs zero API calls.

### The flag-first rule (load-bearing)

```
if any noul > flag_threshold      -> rework/escalate  (ignore the choice)
else if choice top-prob < abstain -> ask a human
else                              -> follow the choice
```

**Never let a `choice` authorise a pass alone when a `noul` is high.** Measured across five prompt-injection
attacks appended to a report describing a real defect: the nouls held **0.93-0.97 on every run**, while the route
`choice` flipped to `pass` on the authority-claim attack - **reproducibly (2 of 2 runs), at 0.76 confidence**.

That is ABOVE a 0.6 abstain gate. **An abstain rule does not save you here; only flag-first does.** Note also that
the flip is intermittent by attack type (a schema-forcing attack flipped once in two runs), which makes it harder to
notice in production than a deterministic failure. A high-confidence answer is peakedness, not correctness.

### Thresholds measured on 12 labelled gate cases

| Threshold | Value | Evidence |
|---|---|---|
| `flag` (auto-rework) | **0.55** | 0.7 scored 11/12, missing a real defect at 0.66; 0.50-0.60 scored 12/12 |
| `abstain` | 0.60 | the single route error returned confidence 0.28 |
| `auto_apply` | 0.8 | start conservative; lower as override rate falls |
| uncertain band | 0.40-0.60 | route to deeper review |

Re-measure on your own labelled cases before trusting these. Directions, not constants.

## Never route to JEV

- **Arithmetic or counting** - it is not a calculator; error grows with the size of the thing counted.
- **Date comparison** - it reads dates as text.
- **Text generation** - it cannot write a summary or a verdict sentence.

If you cannot say what number means "act", it is the wrong tool.

## Common mistakes

| Mistake | Fix |
|---|---|
| Object criteria on `score` | It is an **array**. |
| Trusting high-confidence `choice` | Confidence is not correctness. Flag-first. |
| One holistic "is this good?" question | Decompose per claim - you need to know WHICH problem. |
| Reading 0.5 as "medium" | Equal odds. Use `score` for a scale. |
| Porting a `noul` threshold to a `choice` | Not comparable. Calibrate separately. |
| No abstain option | Without one it must pick a wrong option. |
| One noul threshold for per-option multi-select nouls | Each per-option noul needs its own calibrated threshold (measured 2026-10-07: 0.55 under-fired on 2/3 tasks). |
| Generic "does the report overclaim?" evidence noul | Scope it to ACCEPTANCE CRITERIA. A generic wording fired on clean work - 0.63/0.73/0.69, 0.75, 0.47 across three tasks while every per-criterion noul was <= 0.20 - because it reacted to the NUMBER of side claims (design notes, TDD narrative) in a long report that no evidence could show; a 6KB report scored 0.26. |
| Treating the deleted_out_of_scope noul as the deletion gate | It is ADVISORY. Deletion detection is code (unmatched-line count/ratio via `deletionCheck`), JEV only advises; measured 2026-10-07: noul 0.56 on a real deletion vs 0.64 on legitimate rewrites. The orchestrator runs `deletionCheck` on the raw diff and lists every unmatched line in the gate row when flagged. |
| Logging only the verdict | Log probabilities + model id + question fingerprint. |
| Assuming the model id | Log the `model` field returned - aliases move. |

## Calibrating

Build 12+ labelled cases with known correct answers, sweep the threshold, pick the cut with best accuracy and no
false-positives on clean cases. Re-run whenever question wording or model version changes - it is your regression canary.

Seven measured ways agents got this wrong without this skill: see `baseline-evidence.md`.
