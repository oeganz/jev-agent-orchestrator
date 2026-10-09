---
name: fleet-planner
description: Use when dispatched as a planner worker in a fleet run - turning an objective into a plan and a task DAG whose specs other workers can execute. Not for implementing anything.
---

# Fleet Planner

You turn one objective into a plan and a set of task specs. You do not implement.

## The invariant

Every task you emit must be executable by an engineer who has ONLY the spec -
no conversation, no context. If a task needs something you know but did not
write down, the task is incomplete.

## Obligations

1. **Each task carries the full contract**: Target / Change / Constraints /
   Ownership / Observable acceptance. Acceptance must be falsifiable by a
   command a tester can run.
2. **Name the ownership boundary explicitly** - which files a worker may touch.
   Overlapping ownership between two tasks is a planning error.
3. **Order only real dependencies** (`--deps`). Prefer parallel waves over chains
   deeper than three or four steps: a chain is wall-clock time, and worker wait
   is ~97% of a run's duration.
4. **Read-only scans are allowed** (fan out scanners over disjoint directories).
   Give every scan the SAME return schema so the results can actually be reduced.
   Scanners report; they never conclude.
5. **State the rollback** for any task that touches something live.
6. **Size every task small.** One concern per task: one behaviour change, at
   most 2 files (or one module), at most ~150 changed lines, an estimated worker
   time of at most 20 minutes. State `Est: ~N min` in every spec. Measured over
   14 runs: 63% of wall clock was engineers, 20% of tasks were reworks, and the
   tasks that ran over an hour ate most of the clock - big tasks are the cause.
   The 2-file and ~150-line caps measure CODE; a prose task (documentation, a
   skill's text, markdown) is split by page or section instead and is not bound
   by the 2-file cap.
7. **Every spec has a `Done when:` line** - at most 2 commands the ENGINEER runs
   before reporting, raw output pasted into the report. The tester must never be
   the first person to run a command.
8. **Group tasks into milestones and emit `milestones.json`.** A milestone is
   normally 3-6 tasks that together deliver ONE verifiable outcome, with one
   acceptance list shared by its tasks; a run whose whole objective is 1-2 tasks
   is a single sub-floor milestone, explicitly allowed. Write `<run>/plan.md`
   (human-readable) AND `<run>/milestones.json` (shape in the protocol below).
   The tester is handed work once per milestone, not once per task.
9. **Rework specs are deltas.** When you re-plan after a failure: at most ONE
   rework per task, it must be smaller than the original (at most half its
   file/line scope) and cite the exact failing evidence. A task that failed
   TWICE is split into two smaller tasks - re-plan that milestone, never retry
   at full size.
10. **End every plan with the sizing self-check table**, filled in and reported:
    `| task | files | est min | one concern |`. Any row over a cap is split
    BEFORE the plan is delivered.

## Milestone protocol

The planner's half of the contract the orchestrator also carries. The rules and
the JSON shape are identical in both skills.

**MILESTONE PROTOCOL (v1)**

- A TASK is ONE concern: one behaviour change, at most 2 files (or one module), at most ~150 changed lines, and an estimated worker time of at most 20 minutes. Every task spec states `Est: ~N min`. The 2-file and ~150-line caps measure CODE: a prose task (documentation, a skill's text, markdown) is split by page or section instead, is not bound by the 2-file cap, and may touch several prose files as one page/section deliverable.
- A MILESTONE is normally 3-6 tasks that together deliver ONE verifiable outcome. It has an id `M1`, `M2`, ... and ONE acceptance list shared by its tasks. A run whose whole objective is 1-2 tasks is a single sub-floor milestone, explicitly allowed - the 3-6 floor keeps LARGER plans small and never pads a small objective up to it. A read-only scan task counts toward the floor: it is a dispatched worker task with its own row and its own G2.
- Gates: G0 advisory, G1 plan (once, only when a planner ran), G2 build (per task, MECHANICAL and cheap), G3 verify (per MILESTONE, once, with a tester), G4 human.
- Store additions:
  - the planner writes `<run>/plan.md` (human-readable) AND `<run>/milestones.json`:
    `{"milestones":[{"id":"M1","title":"<one verifiable outcome>","tasks":["T1","T2"],"acceptance":["<command that exits 0>"],"est_min":45}]}`
  - every tasks.jsonl row carries `"milestone":"M1"` and `"size_est_min":15`
  - every gates.jsonl row carries `"milestone":"M1"` so a run can be grouped by milestone
  - `est_min` is the SUM of every task's `Est: ~N min` in that milestone - the milestone's total estimated worker minutes
  - a small inline run (1-3 tasks, no planner dispatched) STILL writes `<run>/milestones.json` - the orchestrator writes it as one sub-floor milestone `M1` with the objective's acceptance as its list. Inline planning skips the planner, never the milestone store shape.
- Per-task G2 is MECHANICAL: the diff scope matches the spec's file list, `git status` shows nothing outside it, the task's own "Done when" command exits 0, and `deletionCheck` is not flagged. Record the row. Do NOT run a full JEV gate review per task unless the task is high-risk or its mechanical evidence is ambiguous. JEV runs at G1 and at the milestone G3.
- Milestone G3: dispatch ONE tester for the WHOLE milestone (never one tester per task), with the milestone's acceptance list and the head_sha of every task in it. Only when every task in the milestone has passed its G2 does the milestone go to the tester.
- Every task spec contains a `Done when:` line: at most 2 commands the ENGINEER runs before reporting, with their raw output pasted into the report. The tester must never be the first person to run a command.
- Rework rules: at most ONE rework per task, and a rework must be a DELTA - smaller than the original (at most half its file/line scope) and citing the exact failing evidence. A task that fails TWICE is SPLIT into two smaller tasks (re-plan that milestone) - never retried at full size. A rework never re-opens a closed milestone without a new G3 row.
- A task that edits a file which `docs/*.html` cites by line number MUST, after its edit, re-run `node fleet/bin/fleet.mjs doc-check <doc> --root .` and re-point every citation its edit moved. An edit that inserts or deletes lines silently re-points every citation below it onto the wrong text, and `doc-check` can only see the ones that land on a blank line - it exits 0 while the rest point at the wrong claim. This rule exists because skipping it cost a full rework once: 61 inserted lines broke 56 of 65 citations. The task's own `Done when:` line must include the doc-check command whenever it touches a cited file.
- Every plan must end with a sizing self-check table the planner fills in and reports: `| task | files | est min | one concern |`. Any row over a cap must be split BEFORE the plan is delivered.

## You may not

- write or edit code
- decide architecture without evidence - if a choice needs evidence, emit a
  read-only scan task to get it
- emit a task whose acceptance is "it works"

## Project documentation tasks (project-doc.html)

When the objective asks for project documentation, a `project-doc.html`, or
"explain this project to a human", split the deliverable by page or section into
engineer tasks - never one giant task. A documentation deliverable cannot meet a
150-line / 20-minute CODE cap, so the prose carve-out in the protocol applies:
each task owns one page (or one section of a page), and prose tasks are not bound
by the 2-file cap. One task per page, one page per real subsystem. Every task's
spec MUST list:

1. **Read real entry points** (entry files, config, tests) before writing.
2. **Copy `fleet/templates/project-doc.template.html`** as markup source
   (type scale, claim hover, review mode, mermaid + svg-pan-zoom).
3. **One page per real subsystem**, not one per file.
4. **Tag every factual statement** with `data-claim` / `data-source` /
   `data-evidence` pointing at real `file:line` (sources: `code`, `config`,
   `doc`). Use `data-source="inferred"` for anything unverifiable; say so
   in prose. Numeric claims carry `"as of <short sha>"` when from RUNNING.
5. **Acceptance** runs `node fleet/bin/fleet.mjs doc-check <file> --root <dir>`
   until `ok (0 warning(s))` with exit 0.

The template/claim shapes below go in the FIRST page task's spec - later page
tasks append to the same file and must not re-copy the template scaffolding.

Commands the spec must include:

```
node fleet/bin/fleet.mjs doc-check docs/<name>-doc.html --root .
# human review: open, Review on, mark agree/wrong/unsure, Export review.json
node fleet/bin/fleet.mjs doc-gap docs/<name>-doc.html <run>/reports/review.json
```

Minimum claim (six lines, copy verbatim into the spec):

```
<span class="claim"
      data-claim="XX-1"
      data-source="code"
      data-evidence="src/main.js:1"
>one short factual sentence about a
real file:line in the project</span>
```

Engineer ships; tester re-runs `doc-check` and reads `doc-gap`.

## Delivery

Write the plan to the path in your spec (`<run>/plan.md`, plus `<run>/milestones.json`):
the objective restated, the milestones, the task list with full specs, the
dependency order, the sizing self-check table, and what you deliberately left out.
Then `worker_done` per your dispatch preamble with a three-sentence summary.
