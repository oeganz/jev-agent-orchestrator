# Fleet — how to use it

## Start here

Open a Claude Code session **in this directory**:

    cd <path-to-fleet-checkout>
    claude

The six skills under `.claude/skills/` are discovered automatically. Tell the
session to act as the fleet orchestrator, then describe the task — or point it
straight at `.claude/skills/fleet-orchestrator/SKILL.md`:

> load the fleet-orchestrator skill, then: add a `--verbose` flag to the
> deploy script, with tests

That is the whole interface. The orchestrator loads its skill (or reads the
SKILL.md file directly when the session has no Skill tool), breaks the task up,
dispatches an engineer, reviews the gate against evidence it reproduces itself,
dispatches a tester in a fresh agent, and reports back. You are the only one who
talks to it.

**How workers are dispatched.** The default is Claude Code subagents (Agent tool,
background): engineers in place, one writer at a time; testers as a NEW agent in
their own git worktree. Subagents close themselves (nothing to settle) but die with
the session (nothing to resume), and they inherit the session's bypass permissions
- the orchestrator's own `git diff`/`git status` at each gate detects a stray write,
it does not prevent one. Orca is kept for a reviewer that must provably be unable
to write, and for long runs that must survive the session; an Orca run starts with
`orca orchestration run-create --objective "..." --json` or `worker-start` fails
with `consumer_fenced`. Each `tasks.jsonl` row records its `dispatcher`.

## Before your first real task

    node fleet/bin/fleet.mjs doctor

It checks the install **and probes that the routed model can actually call tools**.
That last check matters: a model that emits tool calls as text makes a worker fail
while looking like it is working. If it fails, do not dispatch — the proxy has
routed you somewhere unusable. Re-run; it is intermittent.

Doctor also checks config.json, the run store, all 6 repo skills (fleet-orchestrator,
-planner, -engineer, -tester, -devops, jev-scoring), reviewer-settings.json and the
milestone-store shape (`--fast` skips the model probe described above). Four items
are advisory (`note`, never a failure): the global
`~/.claude/skills/orchestration/SKILL.md`, a repo-root `CLAUDE.md`
(a private-checkout convenience file, absent in this tree — the fleet-orchestrator
skill is the real activation path), the `orca` CLI, and the JEV key. Missing orca
or JEV is fine: the README documents both as optional and the fleet falls back to
its subagent dispatcher and full orchestrator gate review. **Any non-advisory
failure exits 1.**

## Inspecting what happened

| command | answers |
|---|---|
| `node fleet/bin/fleet.mjs status` | is Orca up, how many runs, is the JEV key set, any reclaimable terminals or live leaks |
| `node fleet/bin/fleet.mjs settle` | release finished Orca workers; archive-then-close live `user_takeover` leaks |
| `node fleet/bin/fleet.mjs runs` | every run, its status, gate/task counts |
| `node fleet/bin/fleet.mjs report <run-id>` | the gate verdicts and the summary |
| `node fleet/bin/fleet.mjs timing [run-id]` | where the time went — worker vs orchestrator |
| `node fleet/bin/fleet.mjs cost` | today's spend vs the daily cap |
| `node fleet/bin/fleet.mjs estimate <path..>` | pre-flight cost RANGE for a set of paths |
| `node fleet/bin/fleet.mjs resume <run-id>` | take the lease, reconcile against Orca |

Every run is a directory under `fleet/runs/<run-id>/`:

    run.json      objective, status, planted-defect notes
    plan.md       the planner's human-readable plan (when a planner ran)
    milestones.json  the planner's milestones: id, title, tasks, acceptance, est_min
    tasks.jsonl   one row per dispatch, each with the base_sha for its diff
    gates.jsonl   one row per gate: verdict, why, JEV's verdict, whether they agreed
    reports/      what the workers actually wrote
    summary.md    the consolidated report

The tester runs once per milestone (3-6 small tasks), not once per task; per-task
G2 is a mechanical check.

**`gates.jsonl` is the interesting one.** Where the orchestrator and JEV disagreed
is the most valuable row in the store — it is how the thresholds get tuned.

## The rules the orchestrator follows

- fleet first: workers implement; it acts directly only when the fleet cannot (or
  for trivial run-store / git-exclude / leaked-terminal ops), and every such action
  is a `gates.jsonl` row with `decided_by: "orchestrator-direct"` reported to you
- irreversible actions (deploy, push, force-push, delete-data, infra-change,
  spend-above-cap) always come to you (G4)
- never accepts "done" from prose; it reproduces the commands and reads the raw output
- a reviewer cannot write: verified by `node fleet/bin/reviewer-isolation.test.mjs`
- if something blocks it, it **stops and says so** rather than improvising

## When something is wrong

| symptom | do this |
|---|---|
| `doctor` fails on tool-call | re-run; the proxy route is intermittent |
| a run stalls | Orca run: `resume <run-id>` — it reconciles disk against Orca and reports orphans. Subagent run: nothing to resume; it is re-dispatched |
| `status` shows leaks | `settle` — finished Orca workers end `retained`/`user_takeover`, which `worker-release` refuses; settle archives their output to `fleet/runs/_archive/` then closes them. Only a terminal still live in `orca terminal list` counts as a leak |
| a worker did nothing | check `tasks.jsonl` for its row, then `orca orchestration worker-list` |
| JEV unreachable | nothing — the gate falls back to orchestrator review by design |
| cost figures look odd | `cost` is weighted tokens; the **daily cap is uncalibrated**, so it reports and does not block |

## What is proven and what is not

**Proven:** the loop runs end-to-end (3 real runs), a planted defect was caught, the
rework branch closes, reviewer isolation holds (3/3), JEV failover works with a
broken primary, JEV authority scores 5/5 on labelled cases, tool-call probing works.

**Not proven:** a *cold* session completing a whole loop unattended. It reads its
instructions and holds its boundary — verified across four attempts — but the runs
completed were driven by an already-informed session.

**Not built:** the daily cap is a number only you can supply, so the budget gate
reports rather than blocks.

## What carries across sessions

Project memory lives at the Claude Code project-memory path for this checkout
(usually `~/.claude/projects/<encoded-checkout-path>/memory/`). It holds
the JEV endpoint + measured gotchas, the flag-first rule, this project state, and
the note that claims get measured before asserted. A new session loads the index
automatically, so the fleet does not relearn its own lessons each time.

## Files worth knowing

    CLAUDE.md                 repo-root convenience file (advisory; not in the exported tree)
    .claude/skills/fleet-*    the five role skills: orchestrator, planner, engineer, tester, devops
    .claude/skills/jev-scoring  how to score anything with JEV
    fleet/config.json         policy: gates, budget, model slots, providers
    docs/superpowers/specs/   the full design (1012 lines) and its known flaws, plus the
                              repo-split-and-monitor design (371 lines)
