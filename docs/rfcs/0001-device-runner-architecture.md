# RFC 0001: Device-runner architecture

**Status:** Accepted (foundational)
**Authoritative source:** [ADR 0001](../decisions/0001-device-runner-architecture.md)

The device-runner architecture (separating control plane from runtime, with Claude credentials living on user devices rather than the server) is captured in **ADR 0001** as the foundational decision. This RFC entry exists so cross-references resolve; it does not duplicate the design.

## Why an RFC entry?

ADR 0001 was written before the project formalized the RFC process. Several documents reference `rfcs/0001-device-runner-architecture.md` historically (audit closure docs, architecture overview, dual-principal auth ADR). This file preserves those links by pointing at the canonical ADR.

## Read this instead

- [ADR 0001 — Device-runner architecture](../decisions/0001-device-runner-architecture.md) — full design + context
- [ADR 0004 — No Claude credentials on server](../decisions/0004-no-claude-credentials-on-server.md) — reinforces device-runner constraint
- [ADR 0005 — Dual-principal auth](../decisions/0005-dual-principal-auth.md) — protocol layer for the user/device split
- [docs/architecture/system-overview.md](../architecture/system-overview.md) — current implementation map
