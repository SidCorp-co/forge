# Modules

Feature documentation organized by business domain. Each module answers "where does this data come from, how does it transform, and where does it go?" — not "which class handles this."

## Business Domains

| Module | Description |
|--------|-------------|
| [issues-pipeline](issues-pipeline/) | The 18-status issue pipeline. Projects, issues, comments, labels, activity log. The PM core. |
| [agents-jobs](agents-jobs/) | Job queue, dispatch, JobEvent streaming, session capture. The execution orchestration layer. |
| [devices](devices/) | Device pairing, revocation, project binding, heartbeat. The runtime plane connection point. |
| [skills](skills/) | Built-in `forge-*` pipeline skills + user-authored skills. Registration into pipeline stages. |
| [memory-knowledge](memory-knowledge/) | v2 cognitive layer over Postgres `pgvector` — extraction, consolidation, decay, and indexing for semantic recall. |
| [chat](chat/) | Interactive chat sessions with agents. Separate from pipeline jobs — this is conversation. |

## Shared concerns (cross-module)

| Topic | Where it lives |
|-------|----------------|
| Authentication & authorization | [../architecture/system-overview.md § Security boundaries](../architecture/system-overview.md) |
| WebSocket broadcasts | [../architecture/websocket.md](../architecture/websocket.md) |
| MCP server | [../architecture/system-overview.md § MCP](../architecture/system-overview.md) |

## How modules interact

See [../architecture/cross-module-flows.md](../architecture/cross-module-flows.md) for end-to-end flows that touch multiple modules.
