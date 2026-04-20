# ADR 0001 — Adopt device-runner architecture

- **Status:** Accepted
- **Date:** 2026-04-19
- **Full design:** [RFC 0001](../rfcs/0001-device-runner-architecture.md)

## Context

The original monolith ran the agent runner in-process inside the Strapi backend. A security audit (2026-04-19) surfaced critical findings:

- Row-level access checks missing on `issue` / `task` / `comment` controllers
- WebSocket broadcasts reaching every connected client with no project scoping
- `crossProjectAccess` MCP flag bypassing project boundaries
- JWT TTL of 365 days stored in `localStorage`
- The server simultaneously held Claude credentials, spawned subprocesses, and served HTTP

These are not bugs to patch individually — they are symptoms of one server being orchestrator, executor, and credential vault at once.

## Decision

Split the system into two planes:

1. **Control plane** — Strapi backend does orchestration, persistence, broadcast. Never holds Claude credentials.
2. **Runtime plane** — paired **device agents** run `claude` CLI locally. Two form factors share a Rust `agent-core` crate:
   - `dev` (Tauri GUI) — developer-facing
   - `forged` (CLI daemon) — headless for CI / long-running boxes

Introduce dual-principal authorization (user JWT + device token) with a shared policy layer.

## Rationale

- Claude credentials live where the user already keeps them — in the OS keychain of the device. A server breach cannot leak them.
- The lifetime mismatch (HTTP request = milliseconds; agent job = minutes to hours) is resolved by moving execution off the request path.
- The audit findings get resolved as a side effect of the architectural split, not through a long patch trail.
- The product matches what developers actually want: "remote-control your local Claude Code" — not "send your code to someone else's cloud."

## Alternatives considered

1. **Patch audit findings in place** — rejected: doesn't answer whether the server should hold Claude credentials at all; leaves lifetime mismatch.
2. **Extract the agent worker into a separate server-side process** — rejected: keeps credentials centralized; doesn't match the "your Claude on your machine" value prop.
3. **Peer-to-peer device mesh, no central orchestrator** — rejected: kills the "remote control from anywhere" vision; NAT traversal + offline queuing is massive engineering.
4. **Use Temporal or Inngest instead of rolling a queue** — rejected at this stage: adds a required service for contributors running locally; pg-boss covers v0.x needs. Possible later.

## Consequences

### Positive
- Explicit trust boundary — server breach does not leak Claude tokens
- Compute scales with users for free (users bring their own machines)
- Architecture matches the product pitch verbatim
- Audit findings resolved at the design level, not patch level

### Negative
- Steeper onboarding: signup → pair device → bind project → first job (~10 min vs ~2 min before)
- Operational burden: two new binaries, code signing, platform-specific bugs
- State distributed across devices — troubleshooting requires user-supplied logs
- Forecloses a future "serverless agent" product
- Migration is lossy: existing agent sessions archived read-only

## Related

- Supersedes earlier informal design where agents ran in-process
- Drives: [ADR 0003](0003-claude-code-cli-as-primary-runner.md), [ADR 0004](0004-no-claude-credentials-on-server.md), [ADR 0005](0005-dual-principal-auth.md)
