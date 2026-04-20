# ADR 0004 — Server never holds Claude credentials

- **Status:** Accepted
- **Date:** 2026-04-19

## Context

A server that holds credentials for powerful downstream services becomes the most valuable target in the system. Breach consequences scale with the number of users whose credentials are co-located.

For Jarvis Agents, the relevant credential is each user's access to Claude (via their Claude Code CLI login or API key). If the server held them:

- A breach would expose every active user at once
- Self-hosters running for small teams would still accept the blast radius of single-instance compromise
- We would have an implicit "insurance liability" every time we touch production

## Decision

The Jarvis Agents server — in any configuration, public or self-hosted — **never holds Claude credentials**. This is an architectural commitment, not a preference.

- Claude credentials live on user devices, in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- The server dispatches jobs to paired devices; devices run `claude` locally with the user's own credentials
- The server has no API endpoint for storing Claude tokens, no secret rotation flow, no "paste your API key here" form
- If a feature would require the server to hold Claude credentials, the feature is rejected architecturally, not deprioritized

## Rationale

- **Trust boundary is clean** — server breach affects Jarvis data (issues, jobs, projects), not Claude access
- **Self-host story becomes credible** — regulated teams, agencies, privacy-sensitive shops can adopt without risk of server-side credential exfiltration
- **Competitive differentiation** — every cloud AI agent service (Devin, Cursor cloud) holds some form of credential. This is the explicit "not that" positioning.
- **Regulatory simpler** — no PCI/SOC2 considerations for credential storage; the scope shrinks
- **Compounds with [ADR 0003](0003-claude-code-cli-as-primary-runner.md)** — the CLI-as-runner decision makes this architecturally free

## Alternatives considered

1. **Encrypted credential storage on server** — rejected: encryption at rest is not a trust model; the server still has the decryption key. Any operation that uses the credential decrypts it. A clever attacker gets the plaintext.
2. **HSM / Secret-manager integration** — rejected: adds infrastructure complexity disproportionate to our team size; still doesn't solve the fundamental "server has access" problem.
3. **Forward-only credential relay (ephemeral)** — rejected: even transient hold during a request is a compromise vector. Cleaner to never have them in-process.

## Consequences

### Positive
- Security posture dramatically simpler
- Self-hosting adoption easier to justify legally
- Differentiation vs cloud competitors is architectural, not marketing
- Audit: "what would an attacker gain from breaching Jarvis?" has a bounded answer

### Negative
- No "set-and-forget" cloud use of Claude (users must have a device paired to do work)
- Recovery UX is harder — if a user loses all paired devices, they must re-pair
- Enterprise customers who want centrally managed credentials are not our audience (acceptable, per [ADR 0001](0001-device-runner-architecture.md))

## Enforcement

- Code review: any PR that adds credential-storage fields to schemas or APIs must be rejected
- Architecture test (future): a test that the database schema contains no `claude_token`-shaped columns
- Documentation: every major doc (README, architecture, NORTH-STAR) states this commitment

## Related

- Reinforced by: [ADR 0001](0001-device-runner-architecture.md), [ADR 0003](0003-claude-code-cli-as-primary-runner.md)
- Compatible with: future managed-runner ADR, if we ever build one — the managed runner would be a separate service users opt in to, not the default
