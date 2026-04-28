# Integrations

Documentation for external platforms that connect to Forge. Platform specifics live here; business flow stays in [../modules/](../modules/).

## Available integrations

_(None documented in depth yet. Core webhook ingestion works with generic JSON POST; platform-specific shapes will be documented as they stabilize.)_

## Planned documentation

| Integration | Direction | Status |
|-------------|-----------|--------|
| GitHub Issues (webhook in) | Inbound | Supported generically, docs planned |
| GitHub PR (status out) | Outbound | Planned v0.3 |
| Sentry (error → issue) | Inbound | Supported generically, docs planned |
| Stripe events | Inbound | Supported generically |
| Slack / Discord notifications | Outbound | Planned v0.3 |
| Cloudflare DNS (subdomain management) | Operational | Documented |
| MCP client integrations (Claude Code, Cline, etc.) | Bidirectional | Documented in [../architecture/system-overview.md](../architecture/system-overview.md) |

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
