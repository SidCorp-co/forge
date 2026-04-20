# ADR 0007 — Apache-2.0 license for the project

- **Status:** Accepted
- **Date:** 2026-04-18

## Context

The project needs an OSS license. Common options for developer tools:

- **MIT** — permissive, very short, no patent grant
- **Apache-2.0** — permissive, explicit patent grant, slightly longer header requirements
- **AGPL-3.0** — copyleft; modifications must be shared even when provided over a network
- **BSL (Business Source License)** — source-available, converts to OSS after a delay
- **Dual license** — MIT / Apache + commercial

## Decision

**Apache-2.0** for all code in the repo, forever. No dual licensing, no BSL. No commercial-only features in the core repo.

## Rationale

- **Explicit patent grant** — important for a product positioned next to Anthropic, where patent risk is non-zero for anyone building on top of their tooling.
- **Contributor friendly** — Apache-2.0 is the standard for OSS at this scale; contributors know what they're agreeing to.
- **Commercial-compatible** — permissive enough that companies can adopt without legal friction.
- **Clear signal** — "Apache-2.0, forever" is part of the product's trust positioning. BSL or AGPL send a different, more defensive signal.
- **Simpler than dual licensing** — no CLA gymnastics for future commercial monetization.

## Alternatives considered

1. **MIT** — rejected: no patent grant; equivalent in permissiveness but weaker defense for contributors.
2. **AGPL-3.0** — rejected: several companies ban AGPL in their dependencies; this would shrink the audience materially without buying us much (our commercial model is hosted services, not license enforcement).
3. **BSL / SSPL** — rejected: these are defensive against AWS-style reselling; we don't run a database, the risk model doesn't fit. BSL also signals "not really open source" which damages community-building.
4. **Dual license (Apache + commercial)** — rejected: complicates governance; requires CLAs; invites "what does 'commercial' mean exactly?" disputes.

## Consequences

### Positive
- Any team can adopt without legal review
- Patent grant protects contributors and users
- Commercial-friendly — enables partnerships, integrations, even future managed hosting
- Aligns with project principle: "Apache-2.0, forever"

### Negative
- Someone can take the code and launch a competing managed service (acceptable — we're not primarily a cloud business)
- No license-based defense against cloud reselling (mitigated: our value is pipeline + session replay + architecture, not the code itself)

### Irreversible
- **License changes are effectively impossible** once we have external contributors without CLAs. Every contributor would need to agree to the new license. This ADR is a one-way commitment.

## If a future business model demands different licensing

Write a new ADR that supersedes this one **before accepting any external contributions that would block the change**. Options at that point:

- Keep core Apache-2.0, add a separate repo for premium features under a different license
- Offer a managed service (hosting) that doesn't require license changes
- Keep this decision as-is and build a business on services, not licensing

Do not attempt to relicense the existing code.

## Related

- Stated in: README.md, NORTH-STAR, LICENSE file
- Constrains: future commercial monetization (hosted services, not license walls)
