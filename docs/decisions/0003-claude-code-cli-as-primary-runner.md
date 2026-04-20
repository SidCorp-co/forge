# ADR 0003 — Claude Code CLI as primary runner (not Anthropic API)

- **Status:** Accepted
- **Date:** 2026-04-19

## Context

Jarvis Agents orchestrates AI-driven engineering work. There are two ways to invoke Claude:

1. **Anthropic API directly** — server holds an API key, makes HTTP calls to Anthropic, pays Anthropic per token.
2. **Claude Code CLI** — the `claude` binary the user already has installed, using the user's own Claude Pro / Max subscription.

The product's audience is developers who already pay for Claude. Asking them to switch to a second API billing relationship (with us holding the key) is friction, not value.

## Decision

Claude Code CLI is the primary — and in v0.x, only — runner for agent jobs. Jarvis Agents never calls the Anthropic API directly for code-generation work.

The runner protocol is pluggable: future runners (browser-based via Antigravity, custom enterprise gateways, other LLM providers) can be added behind the same JobEvent protocol. But the default, optimized path is Claude Code CLI.

Antigravity is an **optional** runner for use cases where browser automation matters (cost-efficient visual testing, for example). Not required for v0.x.

## Rationale

- **Matches the product promise** — "remote-control your local Claude Code." Using the API directly would be a different product.
- **No second billing relationship** — users continue to pay Anthropic; we add no cost layer.
- **Credential boundary** — [ADR 0004](0004-no-claude-credentials-on-server.md) would be impossible if we called the API. The CLI approach makes "server never holds credentials" architecturally free.
- **Sees the environment** — `claude` CLI has access to the user's git, tools, MCP servers, environment. Passing all of that over an API would be a massive reimplementation.
- **Faster iteration on Claude Code features** — when Anthropic adds a Claude Code feature, we get it for free. Calling the API means reimplementing equivalents.

## Alternatives considered

1. **Anthropic API with user-supplied API key** — rejected: adds a billing setup step; some users (Claude Pro/Max) don't have API access; loses access to the MCP / tool ecosystem that Claude Code aggregates.
2. **Both — let users choose API or CLI** — rejected for v0.x: doubles the code path, doubles the support surface, dilutes the value prop. Can be added later if real demand emerges.
3. **LLM-agnostic runner (OpenAI / Gemini / local)** — rejected for v0.x: the pipeline skills are shaped around Claude Code's tool model. A generic runner would strip the product's specificity.

## Consequences

### Positive
- Product promise is architecturally enforceable
- No per-seat billing operations
- Users keep their Claude subscription value
- Free upgrades when Claude Code gains features

### Negative
- Users must have Claude Code installed (prerequisite, not feature)
- Users without Claude Pro/Max cannot use Jarvis Agents
- Lock-in to the `claude` CLI's output format — changes upstream can break parsing
- Positioning conflict with teams that want to standardize on a non-Anthropic model

### Mitigation for upstream changes
- Version-pin Claude Code in CI matrix
- Subscribe to Anthropic release notes
- Abstract output parsing behind a version-detection layer so we can fork for breaking changes without rewriting the whole runner

## Related

- Enables: [ADR 0004](0004-no-claude-credentials-on-server.md)
- Constrains: runner plugin design (future ADR on pluggable runners)
