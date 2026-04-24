# Security

Per-release security audit closures. For vulnerability reporting policy see [../../SECURITY.md](../../SECURITY.md).

## Audits

- [v0.1.0-rc.1](audit-v0.1.0-rc.1.md) — 2026-04-24 — closes 2026-04-19 findings (device-runner split + policy layer + room-scoped WS + pgvector single-store)

## Process

Each release cut creates `audit-v<version>.md` closing out any open findings or documenting deferrals. Evidence cells must resolve to concrete file paths / ADR sections on `main` at the time of release.
