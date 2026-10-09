# Fleet Repo Extraction + Agent Monitor + Vault Reorg — Design Spec

**Date:** 2026-10-04
**Status:** Draft — awaiting user review
**Path:** C:\AI\<vault>\Agent\Orchestrator

Three sequential sub-projects:

| # | Sub-project | Risk | Order |
|---|---|---|---|
| SP1 | Extract the fleet to its own git repo | low | 1st |
| SP3 | Agent monitor — React Flow graph of every agent + its comms | medium | 2nd |
| SP2 | Full vault reorganization | high | 3rd |

Order is **Split → Monitor → Reorg**: unblock the repo, build the valuable
thing, leave the risky filesystem work for last when nothing depends on it.

---

## 1. Goal

1. `Agent/Orchestrator` becomes an independent git repo with its full history.
   `<vault>` stops tracking it.
2. A live monitor at `Agent/Orchestrator/monitor/` that draws **every AI agent
   on this machine** as a node and **every message between them** as an edge —
   React Flow, live.
3. The vault folder tree is reorganized into a legible top-level layout.

## 2. Context — verified state (2026-10-04)

### 2.1 Git topology — the split is nearly free

`<vault>` (branch `master`, no remote, 68 commits, 3 MB `.git`) **tracks
only**:

- 105 files under `Agent/Orchestrator/`
- `README.md`
- `.gitignore`

Everything else at vault root is **untracked**: `Company/` (22 GB),
`ganz-command-center/` (848 MB), `.gbrain/` (60 MB), `Scripts/` (53 MB),
`Projects/`, `VPS/`, `Personal Branding/`, `Agent/Hermes/`, `fleet-template/`,
`.obsidian/`, `.claude/`, `.mcp.json`, `config.json`, `run-gbrain-mcp.*`,
`CLAUDE.md`.

**Consequence:** the parent repo's history *is* the fleet's history. Extraction
is a `git subtree split`, not a migration.

### 2.2 The agent event model — verified live

Orca is already the aggregation layer for agent activity on this machine.

**Comms edges** — `orca orchestration inbox --json` returns one record per
message:

```json
{ "id": "msg_b94db4313dcc", "run_id": "run_e9da5e91ca1c",
  "from_handle": "term_7ac45f96-…", "to_handle": "run:run_e9da5e91ca1c",
  "subject": "eng-be1 succeeded (T2 + T3 done, suite green)", "body": "…",
  "type": "heartbeat", "created_at": "2026-10-04T11:53:55Z", "sequence": 17 }
```

**Agent nodes** — `orca orchestration worker-list --json` returns one record per
worker:

```json
{ "dispatchId": "ctx_c05cc8d0f842", "taskId": "task_d875bf6442cf",
  "runId": "run_e9da5e91ca1c", "workerState": "ready",
  "dispatchStatus": "dispatched", "agentTerminalHandle": "term_7ac45f96-…",
  "terminalState": "active",
  "resource": { "worktreeId": "…::<repo>/Company/…/<client>-tools" } }
```

Node identity is the **terminal handle**; edges join to it by `from_handle` /
`to_handle`. Both commands support `--json`.

**Liveness** — `orca orchestration check --wait` blocks until a matching
message arrives (long-poll, push-equivalent). Also `run-list --json`,
`task-list --json`, `gate-list`.

**Claude session ingress** — every Orca-pane Claude session already POSTs its
lifecycle events (SessionStart, UserPromptSubmit, Stop, StopFailure,
SubagentStart, SubagentStop, …) to a local Orca hook on `:50871`
(`~/.orca/agent-hooks/claude-hook.cmd` → `claude-hook-impl.cmd`). The hook
exits early when `ORCA_AGENT_HOOK_PORT` is unset, so **plain-terminal Claude
sessions do not report**.

**Not an event source:** `%APPDATA%/orca/logs/main.trace.ndjson` is internal
telemetry (git exec spans, memory breadcrumbs), not agent comms.

**Verified live example:** run `run_e9da5e91ca1c` (<client>-151) has an active
worker `ctx_c05cc8d0f842` in state `ready` that the fleet run store does not
show — dispatched after the last `tasks.jsonl` row. The store is a *projection*
of Orca, and a lagging one.

### 2.3 Two fleet copies

| | `Agent/Orchestrator/` | `fleet-template/` |
|---|---|---|
| Tracked in parent | yes (105 files) | no — has own `.git` (2 commits, 29 files) |
| bench/ | yes | no |
| docs/evidence/ | yes | no |
| docs/diagrams/ | yes | no |
| jev-scoring skill | yes | no |
| dashboard-server.mjs | yes | no |

`fleet-template/` is a strict **subset**. Only unique artifact is its
template-framing `README.md` (clone-into-a-project instructions).

### 2.4 Hermes / ZenoA

`Agent/Hermes/zenoa-api.py` listens on `0.0.0.0:8080`; `GET /health` (liveness)
and `GET /` (info) are unauthenticated. A separate agent stack — no Orca
integration. (Bug: `launch-server.py` references `zenoma-api.py`, a typo for
`zenoa-api.py`.)

---

## 3. Decisions (user-confirmed)

| # | Decision | Choice |
|---|---|---|
| S1 | Repo location | `Agent/Orchestrator`, in place — its own `.git` |
| S2 | fleet-template | Absorbed/deleted — one repo, `Agent/Orchestrator` wins |
| S3 | Git history | Preserved via `git subtree split` |
| S4 | Session transcripts | Scrubbed copy committed under `sessions/`; raw jsonl gitignored |
| S5 | Cleanup scope | Full vault reorganization |
| S6 | Monitor home | `Agent/Orchestrator/monitor/` |
| S7 | Monitor coverage | Full machine: Orca + all Claude sessions (own hook) + Hermes |
| S8 | Order | Split → Monitor → Reorg |

---

## 4. SP1 — Fleet repo extraction

### 4.1 Sequence

1. **Commit pending work in the parent first.** The tree is dirty:
   `fleet/bin/lib/runs.mjs` modified; run dir `20261004-1743-<client>151-report-upload/`
   untracked. Both must land in the parent commit or the split drops them.
2. `git subtree split -P Agent/Orchestrator -b fleet-split` — yields a branch
   whose history is the fleet's, re-rooted at the fleet root.
3. `git init -b main` inside `Agent/Orchestrator`; add the parent's `.git` as a
   temporary remote by path; fetch `fleet-split`; reset to it; drop the remote.
   The working tree already matches, so this is history plumbing only.
4. Write the new repo's `.gitignore`: `.env`, `**/.env`, `sessions/raw/`,
   `.claude/settings.local.json`, `node_modules/`, and `fleet/runs/` depending
   on the call in §4.3.
5. Parent: `git rm -r --cached Agent/Orchestrator`; add `Agent/Orchestrator/`
   to the parent `.gitignore`. Parent keeps its `.git` — its fate is SP2's call.
6. Delete `fleet-template/`; salvage its README as `docs/README-template.md`.

### 4.2 Transcript preservation

Source: `~/.claude/projects/C--AI-<vault>-Agent-Orchestrator/` (44 MB of
`.jsonl`).

- Copy raw to `sessions/raw/` — **gitignored**.
- Emit scrubbed copies to `sessions/` — **committed**.
- Write `sessions/INDEX.md`: session id, date, size, first-prompt summary.

Scrubber must redact: `sk-or-v1-…`, `kn-…`, `Bearer …`, `api_key=…`, `X-ZenoA-Key`,
and the literal `Agent/Orchestrator/.env` key block (`LLM_API_KEY`,
`JEV_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `Z_AI_API_KEY`, gbrain bearer).

> The live `.env` is gitignored and stays live. A user-chosen alternative was to
> rotate the keys instead; not chosen. If any transcript is committed unsrubbed,
> those keys are in git history permanently.

### 4.3 Risks

- **Run store in the repo — decided.** Commit the four completed runs
  (`hello-runcount`, `defect-hunt`, `rework-loop`, `<client>151-report-upload`) as
  evidence, then gitignore `fleet/runs/` so future runs stay local and the repo
  does not grow with every run.
- Only destructive step is deleting `fleet-template/` — already-untracked content
  with a verified superset.
- `git subtree split` requires the path to exist across history; the directory
  was created mid-history, which subtree handles.

### 4.4 Verification

- `node fleet/bin/fleet.mjs doctor` passes in the new repo.
- `git log --oneline | wc -l` equals the parent's count of commits touching
  `Agent/Orchestrator` — **measured 67** (of the parent's 68 total; the
  remaining commit predates the fleet directory).
- The <client>-151 run dir is present with its `base_sha` rows.
- `git -C <repo> ls-files Agent/Orchestrator` returns nothing.

---

## 5. SP3 — Agent monitor

**Built 2026-10-04 — live at `http://localhost:8790` (commit 7279749).**
Built ahead of SP1 because the user asked to see it working before committing to
the design. Two shape decisions were settled while building, both the user's:

- **Force-directed**, not the hub-and-spoke originally sketched.
- **All agents across all runs at once**, not one selected run.

### 5.1 Sources (all verified)

| Source | Command / endpoint | Gives |
|---|---|---|
| Orca workers | `orca orchestration worker-list --json` | nodes: handle, state, worktree |
| Orca comms | `orca orchestration inbox --json` | edges: from→to, subject, ts, seq |
| Orca runs/tasks | `run-list --json`, `task-list --json` | grouping, DAG |
| Orca liveness | `check --wait` | push-equivalent new-message signal |
| Claude sessions | `fs.watch ~/.claude/projects/*/*.jsonl` | all sessions, tool-level detail |
| Claude hook | new POST hook → monitor `/hook` | instant lifecycle events |
| Hermes | `GET http://127.0.0.1:8080/health`, `GET /` | ZenoA liveness/identity |

### 5.2 Architecture

```
sources ──► adapters ──► graph store ──► WebSocket ──► React Flow UI
```

- `monitor/server.mjs` — zero-dep Node HTTP + WebSocket, extending the framing
  already proven in `fleet/bin/lib/dashboard-server.mjs` (raw RFC 6455, no deps).
  That predecessor had a path bug — `listRuns()` enumerated `fleet/` instead of
  `fleet/runs/`, so the dashboard at `:8788` rendered empty. Fixed 2026-10-04;
  the four completed runs now load. It also inherited `PORT=45877` from the
  environment and collided with the Beszel agent — the port must be pinned.
- `monitor/adapters/` — one module per source; each emits normalized
  `{node}` / `{edge}` events.
- `monitor/hooks/` — the Claude hook script + install doc for global
  `settings.json`.
- `monitor/ui/` — React Flow view.

### 5.3 Graph model

- **Node**: `{ id: handle, kind: worker|session|hermes, role, provider, state,
  workspace, lastSeen, source }`
- **Edge**: `{ id, from, to, kind: dispatch|report|gate|heartbeat|done,
  subject, ts, runId, taskId }`

Adapters normalize into this shape; the UI never sees source-specific fields.

### 5.4 Coverage: full machine

- **Orca** — poll `worker-list` + `inbox` on an interval; `inbox --json` is
  incremental by `sequence`, so only new rows are sent.
- **All Claude sessions** — add a second command to the existing global hook
  chain in `~/.claude/settings.json` that POSTs the event to the monitor, with a
  short timeout and fail-open (`|| echo {}`), so a down monitor never blocks a
  session. Filesystem watch on the transcript dirs as a backstop.
- **Hermes** — poll `:8080/health` + `/` on an interval.

### 5.5 UI — built

**React Flow renders; d3-force computes the layout.** Source in `monitor/ui/`
(`src/App.jsx`, `main.jsx`, `styles.css`, Vite config, `package.json`);
`node_modules/` gitignored. `dist/` is built and **committed**, so running the
monitor needs no install and no build step. `monitor/server.mjs` serves `dist/`
as static files. Cost: a built artifact lives in git and the UI needs a rebuild
whenever it changes.

Three findings from building it, each one a silent failure that cost a debug cycle:

1. **A custom node with no `<Handle>` renders zero edges.** React Flow resolves
   the edge endpoint against the node's handles *before* it calls the custom edge
   component, and drops the edge when the position is null (`EdgeWrapper` returns
   null on a null `edgePosition`). Handles must exist even for a floating edge
   that draws centre-to-centre; ours are 1×1 and transparent.
2. **`forceLink` mutates the link array**, replacing `source`/`target` strings
   with node objects. Reading ids back out of it hands React Flow objects where it
   expects strings, so React Flow edges must be built from the untouched payload.
3. **Re-adopting nodes every animation frame with no `measured` field makes React
   Flow reset `handleBounds` each frame**, so they never settle and no edge ever
   renders. The layout is therefore settled in one synchronous pass (300 ticks)
   and only when the node set changes — re-heating on every poll also walked the
   layout out of the framed view, which clipped nodes.

### 5.6 Risks

- **Global hook change** affects every Claude session on the machine. Must be
  fail-open and short-timeout; must be trivially reversible.
- **Orca CLI polling cost** — the CLI spawns a process per call; interval must be
  tuned, and `check --wait` preferred over tight polling.
- **Secrets in the UI** — message bodies can contain anything. The monitor binds
  localhost; document it as the fleet dashboard already does.

### 5.7 Verification

- Live: current <client>-151 worker `ctx_c05cc8d0f842` appears as a node with an
  active state.
- A new `orca orchestration send` produces an edge within one poll interval.
- A freshly started plain-terminal `claude` session appears via the hook.
- UI renders N nodes / M edges matching `worker-list` + `inbox` counts.

---

## 6. SP2 — Vault reorganization

### 6.1 Target layout

```
Agent/          Orchestrator/ (own repo) · Hermes/
Company/        GanzApps/ · <client>/            ← UNTOUCHED
Infra/          VPS/ · Scripts/ · ganz-command-center/
Personal/       Personal Branding/ · Projects/
```

### 6.2 Reference constraints (measured 2026-10-04)

Of the candidate directories, **none is referenced by code**:

| candidate | code refs | notes |
|---|---|---|
| `VPS/` | 0 | holds `creds.txt` + `.env` |
| `Scripts/` | 0 | omniroute-patch + 53 MB of backups |
| `ganz-command-center/` | 0 | Next.js app, 848 MB incl. `node_modules` |
| `Personal Branding/` | 0 | held a stray empty `.git` — removed 2026-10-04 |
| `Projects/` | 0 | `IDLE-RPG` (16 KB) + an **empty** `MRI/` |

The single file the reorg breaks is `Agent/Hermes/ZenoA.md` lines 110–114, which
document those directories by relative path — documentation, six lines.

**Do not move `Company/`** — 22 GB, and 20+ MRI scripts hardcode its path.
`Agent/Hermes` stays under `Agent/` (it is an agent, like the fleet). Vault
infrastructure stays at root: `.gbrain/`, `.obsidian/`, `.claude/`, `.mcp.json`,
`config.json`, `CLAUDE.md`, `README.md`, `run-gbrain-mcp.*`.

Nothing here is tracked by git, so the moves are filesystem-only with no git
impact — which is what makes this step lower-risk than it first looked.

**Status: DONE 2026-10-05.** All five directories moved (`VPS`, `Scripts`,
`ganz-command-center` → `Infra/`; `Personal Branding`, `Projects` → `Personal/`),
and `Agent/Hermes/ZenoA.md` lines 110–114 updated to the new relative paths.
`Company/`, `Agent/`, and vault infrastructure are untouched. Services were
unaffected (the monitor and ZenoA both live under `Agent/`).

**One leftover:** an empty `Personal Branding/` directory remains at the vault
root — its files were copied and verified into `Personal/Personal Branding/`, but
the directory itself is held as a process's working directory and cannot be
unlinked until that process is closed. Harmless; remove it when free.

**Lesson from doing it:** `mv` on a directory can split the tree. Moving
`ganz-command-center` (a git repo) hit a lock partway and left the source holding
the directories while the destination held the tracked files and a working
`.git` — measured as 29 "deleted" files in the repo. It was fully recovered by
moving the remaining directories across, but a directory that must arrive intact
should be moved copy → verify → delete, never bare `mv`.

### 6.3 Approach

- Move only low-reference targets: `Agent/Hermes`, `Scripts`, `VPS`,
  `Personal Branding`, `Projects`, `ganz-command-center`.
- Before each move: grep for the old path, update references in the same change.
- **Parent repo fate — decided.** Keep `<vault>` as a git repo. With
  `Agent/Orchestrator` untracked it tracks only `README.md` and `.gitignore`;
  that is acceptable, and the vault can start tracking other content later.
- Present a destructive-action list for per-item approval before moving anything.

---

## 7. Out of scope

- Autostart / service-izing the monitor.
- Remote/multi-machine monitor (single machine only; `ganz-command-center` owns
  mesh-level monitoring).
- Fixing `launch-server.py`'s `zenoma-api.py` typo (noted, separate).
- The v2 fleet milestones (M4–M8) in the 2026-10-03 design.

## 8. Resolved questions

1. **Run store in the repo** (§4.3) — commit the four completed runs; gitignore
   `fleet/runs/` for the future.
2. **React Flow build** (§5.5) — Vite, with `dist/` committed.
3. **Parent repo fate** (§6.3) — keep `<vault>` as a repo (*.git
