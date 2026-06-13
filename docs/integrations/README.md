# Integrations

Documentation for external platforms that connect to Forge. Platform specifics live here; business flow stays in [../modules/](../modules/).

The shared machinery (registry, vault, delivery log, queue, adapter contract) is documented in **[framework.md](framework.md)** — read that first.

## Available integrations

- **[Integration framework](framework.md)** — registry / vault / queue / adapter pattern, inbound webhook routing, and how to add a provider.
- **Coolify** (deploy automation) — the one live adapter; covered in [framework.md](framework.md#coolify-adapter).
- **Sentry** — Forge's own observability (breadcrumbs), not a per-project adapter; see [framework.md](framework.md#sentry).

_Other platform-specific shapes will be documented here as they stabilize._

Inbound webhooks (GitHub, Sentry, Stripe, custom) are supported generically via [framework.md](framework.md#inbound-routing); platform-specific docs get added here as adapters ship. MCP client setup is in [../architecture/system-overview.md](../architecture/system-overview.md).

## How to add an integration doc

1. Name the file `{platform}.md` (e.g. `github.md`, `sentry.md`)
2. Cover:
   - Direction (inbound webhook / outbound call / MCP / other)
   - What the external platform sends or expects
   - How Forge maps the platform's fields to internal entities
   - Auth mechanism (secret, OAuth, API key)
   - Required permissions on the external side
   - Known quirks / rate limits
3. Link from the relevant module README under "Cross-module touchpoints" or from here
