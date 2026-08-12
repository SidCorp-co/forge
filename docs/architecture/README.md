# Architecture

System-level documentation. For feature-by-feature detail, see [../modules/](../modules/).

## Primary reading order

1. [System overview](system-overview.md) — one-page summary of the control plane + runtime split
2. [Cross-module flows](cross-module-flows.md) — how modules chain together for the main user journeys
3. [WebSocket implementation](websocket.md) — room-scoped broadcast details
4. [Runner daemon](runner-daemon.md) — the Rust `forge-runner` CLI that bridges core ↔ local machine

## Decision records

- [Skill delivery](skill-delivery.md) — **canonical ADR**: two skill kinds, three channels (disk / plugin / MCP-reference), anchors, load-bearing shims.
  - [Skill delivery, channel 3: the plugin marketplace](skill-delivery-plugin-channel.md) — plugin channel mechanism detail.
- [Reopen loop guard](reopen-loop-guard.md) — the reopen-count cap, its device-actor escalation to `waiting`, and why the cap is a single global value rather than complexity-scaled.
- [The closed job loop](job-loop-monitor.md) — the four-hop reap model in `jobs/loop-monitor.ts`, and the ISS-785 kill-before-reap gate that stops a false "silent death" from spawning a second agent.
- [State-integrity guard family](state-integrity-guards.md) — the four guards that stop a status write from asserting work that never happened.
- [Failure taxonomy + action policy](failure-taxonomy-and-action-policy.md) — the single classifier + orthogonal action axis that decides "is this failure worth retrying," and why a spend-cap error fails over per-account instead of parking terminal.

## Related

- Module-level detail: [../modules/](../modules/)
- External integrations: [../integrations/](../integrations/)
