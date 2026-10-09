# Copy-paste installation prompt

Paste the block below into a fresh Claude Code session opened anywhere. It walks
your agent through cloning the repository, running the install check, and
activating the fleet. The raw file is this one; the same block also appears in
the README's "Or: paste this into your agent" subsection.

<!-- SYNC: the fenced block below must stay byte-identical with the block in
README.md ("Or: paste this into your agent"). Edit both together. -->

```
Install and activate the JEV Agent Orchestrator (https://github.com/oeganz/jev-agent-orchestrator).

Verify prerequisites first, and report each result:
- Node >= 18: run `node --version` and confirm the major version is 18 or higher.
- git: run `git --version` and confirm it is present.
- Host: Claude Code is the agent runtime this fleet runs on, and you are running
  in Claude Code right now, so this prerequisite is satisfied by construction.
  Do not try to detect it; just note it as satisfied.

If this repository is not already cloned on this machine, clone it:
- Repository: https://github.com/oeganz/jev-agent-orchestrator.git
- Ask me where to put the clone, propose a sensible default under my projects
  directory, and wait for my confirmation. Do not pick a location silently.

Then, from inside the checkout root (the directory containing fleet/):
1. Run the install check and read its full output:
     node fleet/bin/fleet.mjs doctor
2. Expect these to pass (lines starting "ok"): config.json, run store, the six
   skills (fleet-orchestrator, fleet-planner, fleet-engineer, fleet-tester,
   fleet-devops, jev-scoring), reviewer-settings.json, and the milestone store.
   Expect these as "note" lines, which are ADVISORY and correct on a clean
   machine, not errors: the global orchestration skill, CLAUDE.md (absent by
   design in this repo; the fleet-orchestrator skill is the real activation
   path), the orca CLI, orca reachability, and the JEV key. doctor exits 0 when
   all mandatory checks pass.

Activate:
- Tell me to open future Claude Code sessions in the checkout root. The six
  skills under .claude/skills/ are auto-discovered by Claude Code there.
  .claude/skills/fleet-orchestrator/SKILL.md is the orchestrator's operating
  manual; a session asked to "act as the fleet orchestrator" reads and follows
  it. Note this repository has no CLAUDE.md; activation is the skill, not a
  project file.

Optional extras, skip both and the fleet still works:
- JEV (decision service, first-pass gate verifier): set JEV_BASE_URL in your
  environment or point the providers' base_url entries in fleet/config.json at
  your JEV endpoint, and set JEV_API_KEY for it. Without a key, every gate
  falls back to a full orchestrator review - correct, just slower.
- Orca (isolation-grade dispatcher): install the orca CLI. Without it, worker
  dispatch uses Claude Code subagents.

Finish by reporting honestly:
- What you verified: paste doctor's summary line verbatim (the line starting
  "all checks pass" or a failure equivalent) and list any "note" lines.
- What you did not verify: say plainly whatever you skipped, and stop.
```
