# Contributing

Thanks for your interest in the fleet. This document describes how to make a
change, what the project expects from a change, and how to report a defect.

## What this project is

The fleet is an agent-fleet orchestrator: a harness that takes a software task,
decomposes it into milestones and tasks, and runs it through supervised worker
agents (a planner, engineers, a tester, a devops worker), with a recorded,
reviewed gate at every step. The orchestrator is itself an agent session; workers
are dispatched as subagents, each in its own git worktree where isolation
matters. No worker's claim is accepted as prose — every gate verdict is backed
by a command the orchestrator re-runs itself and pastes raw into the run store.

The full project overview is in [`README.md`](README.md); the operator's guide is
[`QUICKSTART.md`](QUICKSTART.md). Read both before opening a pull request, even
for a small change.

## Getting it running

Requirements: Node.js 18+ (developed on Node 24). There are zero runtime
dependencies — `fleet/bin` is plain ES modules — so a clone plus `node` is
enough to start.

```bash
git clone <your-fork-or-mirror-url> fleet
cd fleet

node fleet/bin/fleet.mjs doctor
```

`doctor` checks the install and probes that the routed model can actually call
tools. It exits non-zero on any failure. `node fleet/bin/fleet.mjs doctor
--fast` skips the model probe and is what CI uses (no JEV key in CI).

## The project's own standard

A change is **not ready** until a command someone else can run proves it. The
practice is plain, and it is the same one the fleet runs on internally:

1. **Test first.** If the change is behaviour, write the test before the
   implementation. The test must fail on the unchanged tree, then pass after
   the change.
2. **Paste raw output.** The test command's raw output goes in the report.
   "4 tests, 4 pass" reads as *no output shown* and is not accepted. Paste the
   block — pass and fail lines alike.
3. **State what you did NOT verify.** A change in scope is a change in
   responsibility. If you edited `fleet/bin/foo.mjs` to fix a bug, but did not
   exercise `fleet/bin/foo.test.mjs`, say so. Honesty about gaps is the rule.
4. **One concern per PR.** Do not bundle a typo fix, a refactor and a feature
   into a single change. Each is its own PR, its own review, its own gate.
5. **Skill changes are behaviour changes.** The fleet's behaviour lives in
   `.claude/skills/**` as prose instructions for the agents. Editing a skill
   file is a behaviour change and needs a test under `fleet/bin/` alongside it
   — the test pinning the contract the skill describes.

The summary line of a PR is not a substitute for the evidence. Reviewers and
the gate service both read the diff and the raw output, not the prose.

## The test suite

The suite is plain Node's built-in test runner. The fleet sources live under
`fleet/bin/` and the monitor sources under `monitor/`; each has `*.test.mjs`
files next to the code.

Run one file:

```bash
node --test fleet/bin/<name>.test.mjs
```

Run a whole subtree (this is what CI runs):

```bash
node --test fleet/bin/*.test.mjs
node --test monitor/*.test.mjs
```

If you add a new behaviour, add a new `*.test.mjs` next to it. If you change an
existing behaviour, update the existing test first so it fails, then make the
change, then re-run it green. A pull request that does not include the
failing-then-passing test cycle is incomplete.

## Pull requests

Each PR should have:

- **A clear one-line summary** at the top of the description.
- **What the PR does, in one paragraph.** A reviewer who has not been in the
  code for weeks should be able to read this paragraph and know whether to
  approve.
- **What you verified.** The commands you ran, with raw output, in a fenced
  block. Cut and paste, do not paraphrase.
- **What you did NOT verify.** A short list. The bigger this list, the more
  scrutiny the change needs.
- **One concern.** If a PR fixes a bug, fixes a typo, refactors and adds a
  feature, it will be sent back. Split it.
- **The skill update, if the change is a skill change.** Skills are first-class
  artefacts; a change to one without a paired test is not ready to merge.

A change that cannot be verified by a command someone else can run is not
ready to merge. This is the fleet's own gate language applied to contributions.

## Reporting a defect

Before opening an issue, run the install check and include its full output:

```bash
node fleet/bin/fleet.mjs doctor
```

A defect report should include:

- What you ran (the exact command, with `--verbose` if available).
- What you expected.
- What happened instead (raw error text, stack trace, log line — paste it).
- The output of `node fleet/bin/fleet.mjs doctor` (CI versions are fine: add
  `--fast` if you do not have a JEV key).
- The operating system, Node version (`node --version`), and any relevant
  environment variables you have set (especially around the JEV endpoint).

If the defect is in a specific run, attach the run id (`node fleet/bin/fleet.mjs
runs` lists them) and the failing gate from `gates.jsonl`. The run store is
the audit trail; a defect with a run id is much easier to reproduce than one
without.

## License

Contributions to this project are accepted under the Apache License, Version
2.0 — the same license as the repository. See [`LICENSE`](LICENSE). By opening
a pull request, you agree to license your contribution under those terms.
