# Architecture

System-level documentation. For feature-by-feature detail, see [../modules/](../modules/).

## Primary reading order

1. [System overview](system-overview.md) — one-page summary of the control plane + runtime split
2. [Cross-module flows](cross-module-flows.md) — how modules chain together for the main user journeys
3. [WebSocket implementation](websocket.md) — room-scoped broadcast details
4. [Runner daemon](runner-daemon.md) — the Rust `forge-runner` CLI that bridges core ↔ local machine

## Related

- Module-level detail: [../modules/](../modules/)
- External integrations: [../integrations/](../integrations/)
