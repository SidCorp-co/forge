# ADR 0009 — Mobile app paused for v0.x

- **Status:** Superseded (2026-05-09)
- **Date:** 2026-04-19
- **Superseded by:** Mobile dropped from roadmap; `packages/app/` deleted on 2026-05-09. The "keep dormant code for lessons learned" tradeoff (Alternative #2) was reversed — the dormant package was bit-rotting (paused dependencies, drifting types, stale chat-sessions wiring) and creating navigation noise for contributors who kept asking what `packages/app/` was for. The Expo/React Native learnings are recoverable from git history (`git log -- packages/app/`). When mobile re-enters the roadmap (no concrete plan as of 2026-05-09), it will likely be a fresh project with current Expo SDK rather than a thaw of frozen v0.1 code.

## Context

The repository includes a React Native (Expo) mobile app at `packages/app/`. It was built alongside the web and desktop clients during the internal alpha.

When [ADR 0001](0001-device-runner-architecture.md) reshaped the system into a device-runner model, the product's value on a mobile form factor shifted. The primary user actions — pair a device, run an agent, review a diff — are either impossible or awkward on mobile (you don't pair a phone as a Claude runner; you don't review a 500-line diff on a 6-inch screen comfortably).

What mobile CAN do well:
- Quick status checks on pipeline health
- Read-only monitoring of in-flight jobs
- Issue review and commenting on the go
- Notifications for pipeline events

But none of these is essential for the first public release. The device-runner implementation (Phase 2) is already substantial. Adding mobile parity work extends timeline without advancing the product's differentiation.

## Decision

- Mobile app is **paused** for v0.x. Development on `packages/app/` halts.
- Existing mobile code stays in the repo, not deleted. Rust lessons-learned style: keep the learnings, freeze the development.
- Mobile returns in **v0.2+** as a read-only dashboard: status, job monitoring, issue comments, push notifications. Not an execution surface.
- No App Store / Play Store submissions during v0.x.

## Rationale

- **Scope protection for Phase 2** — device-runner rewrite (Rust `agent-core`, Tauri `dev`, `forged` CLI daemon) is 4 weeks of work. Adding mobile parity pushes public launch further than we can sustain.
- **Wrong form factor for the primary use cases** — pairing, running jobs, reviewing diffs are all desktop-native.
- **Mobile parity as a v0.1 goal signals the wrong priorities** — a contributor seeing "mobile app v0.1" would assume we're optimizing for mobile workflows, which we're not.
- **Re-entry point is clear** — v0.2+ read-only mobile dashboard is a well-scoped feature that benefits from a stable device-runner model first.

## Alternatives considered

1. **Ship mobile at launch as read-only viewer** — rejected: still adds 2–3 weeks of scope (UI parity, auth flow, push notifications, store submission). Not worth the launch timeline slip.
2. **Delete `packages/app/` entirely** — rejected: the code has lessons learned (Expo routing, React Native patterns) that would be painful to re-derive. Keeping it dormant costs nothing.
3. **Keep mobile as v0.1 scope and cut something else** — rejected: the thing to cut is always mobile, given it doesn't execute the product's core value.

## Consequences

### Positive
- Phase 2 scope stays achievable
- Public launch timeline holds (Week 19, or Week 22-24 after ADR 0002 migration)
- Focus on the differentiator (pipeline + session replay + device-runner) without mobile drag
- No App Store / Play Store operational burden in v0.x (cert management, review delays, policy gotchas)

### Negative
- Users who expect mobile parity at launch will be disappointed — must communicate clearly in README and landing page ("mobile in v0.2")
- Contributor energy on mobile features is explicitly deferred — might lose potential contributors interested only in mobile
- Expo / React Native ecosystem changes during pause — some rework may be needed when we resume

## Re-entry criteria

Mobile work resumes when:
- Device-runner model is stable (4+ weeks without architecture changes)
- Public launch has happened
- At least one concrete request per week for mobile for 4 consecutive weeks, OR an internal user provides a compelling use case

## Related
- Driven by: [ADR 0001](0001-device-runner-architecture.md) (scope re-alignment)
- ROADMAP reference: v0.2 theme T4 (Collaboration & multi-surface)
