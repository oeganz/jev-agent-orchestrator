# fleet/bin — module index and the JEV fallback

> Salvaged on 2026-10-04 from `fleet-template/fleet/bin/README.md`. This content
> was the original `fleet/bin/README.md` here, replaced when the dashboard README
> took that filename. The JEV fallback semantics below have no other home in this
> repo apart from the code and the design spec.

| file | what |
|---|---|
| `fleet.mjs` | CLI: `status`, `runs`, `report`, `timing`, `cost`, `estimate`, `resume`, `doctor` |
| `lib/orca.mjs` | Orca binary resolution + status probe |
| `lib/jev.mjs` | JEV client with the spec-14.9 fallback, and `gateVerdict()` implementing the spec-6 gate policy |
| `jev-fallback.test.mjs` | regression test for the fallback path |

## The fallback is code, not a policy statement

`askJev()` **never throws for an operational failure**. It returns

    { ok:false, degraded:true, reason, detail, action:'orchestrator_review' }

and `gateVerdict()` turns that into `{ verdict:'orchestrator', decided_by:'fallback' }`.
An unavailable filter degrades the gate to orchestrator review. It never
auto-passes and never crashes the run.

`reason` is one of: `timeout` | `unreachable` | `rate_limited` | `unavailable` |
`malformed` | `circuit_open`. A **401/403 is different** — it returns
`fatal:true, action:'stop'`, because a rejected credential is a config error, not
an outage, and must fail loudly rather than degrade.

Circuit breaker: 3 consecutive failures opens it for the cooldown, so later gates
short-circuit instead of each paying the timeout.

## Verified against a real outage

On 2026-10-04 the provider returned `503 all_providers_failed` and the test was
run live: it degraded rather than throwing, the gate escalated to orchestrator
review, and the breaker opened on schedule. Run
`node fleet/bin/jev-fallback.test.mjs` after any change to `jev.mjs`.
