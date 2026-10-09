# Real-time dashboard

A small WebSocket broadcaster (zero dependencies) over the run store, with a
self-contained HTML page rendering the live timeline, the run's objective, and
the inter-agent comms.

    node fleet/bin/lib/dashboard-server.mjs
    # fleet dashboard on http://localhost:8788
    #  (FLEET_DIR=...; PORT=... to override)

The page auto-discovers runs from `fleet/runs/`, picks the most recent as the
active one, and updates as `tasks.jsonl` and `gates.jsonl` are appended. Open it
in any browser; the URL is the only thing you share.

If port 8788 is busy, the env wins — `PORT=8800 node fleet/bin/lib/dashboard-server.mjs`.

What the page shows:

- **Timeline** — every event from tasks.jsonl (dispatch/settle) and gates.jsonl
  (verdict) drawn at its real timestamp, colour-coded by role, with a "now" line.
- **Goals / objective** — the active run's stated objective, current status, gate
  counts (ok / rework), and a planted-defect marker if applicable.
- **Agent comms** — the most recent inter-agent events, in reverse chronological
  order: task dispatches with the recorded `base_sha`, and gate verdicts with
  the orchestrator's `why`. This is the high-signal stream; raw tool calls and
  worker reasoning are NOT shown.
- **Events** — a live log of every event as it lands, newest on top.

Operational notes:

- The server reads the run store directly; it does not run a second store, so
  the run store remains the source of truth.
- Permission model: the server binds to localhost and serves a static page; it
  does not need to be exposed. If you expose it, anyone on the URL can read
  every run's tasks and gates.
