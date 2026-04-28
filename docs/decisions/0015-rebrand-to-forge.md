# ADR 0015 — Rebrand to Forge under SidCorp-co

**Status:** Accepted (2026-04-28)
**Supersedes:** the brand-name section of [ADR 0008](0008-english-as-primary-language.md) ("Brand name stays Jarvis Agents")

## Context

The repo shipped its first public release on 2026-04-19 under `junixlabs/jarvis-agents`. That name was the internal codename used during the Strapi-era prototype and through Phase 2 of the migration. Two problems with continuing as `Jarvis Agents`:

1. **Naming dissonance.** Every code-side identifier already uses `forge` — the desktop bundle is `Forge Beta` (`com.thejunix.forge-beta`), npm packages are `@forge/core` and `@forge/contracts`, the workspace dir was `forge/`, the slash-commands are `/forge-plan`, `/forge-code`, `/forge-review`, etc. New visitors hit "Jarvis" in the marketing copy and "forge" in the code; the friction is real.
2. **Owner mismatch.** The repo lives under a *user* account (`junixlabs`). Open-source SaaS-adjacent projects benefit from an *org* container — team members, billing, project pages, and a stable URL stem that survives the founder's username changing.

The mobile app being paused (ADR 0009) and the v1 epics being early enough (ISS-270..274 not started) means there is no better window to do this than right now.

## Decision

Three coordinated moves, executed atomically:

1. **Transfer ownership** `junixlabs/jarvis-agents` → `SidCorp-co/forge` via the GitHub transfer API. Both rename and ownership change happen in the same call.
2. **Rename the workspace dir** `forge/` → `packages/`. The inner `forge/` was originally an organizational neighbour to `strapi/` (since removed); after the rename the path would have read `forge/forge/core/` for a fresh clone, which is confusing. `packages/` is the conventional pnpm-workspace layout and removes the duplication. npm scope `@forge/*` is unchanged — the brand scope is independent of the directory.
3. **Update Tauri bundle identifier** `com.thejunix.forge-beta` → `co.sidcorp.forge-beta`. Reverse-DNS now points at the new owning org.

`Forge` is the canonical brand from this point. `Jarvis`, `Jarvis Agents`, `JARVIS`, `jarvis-agents` are retired pre-OSS names and should not appear in new code, docs, or commits. Old URLs continue to work via GitHub's automatic 301 redirect.

## Consequences

### Positive

- One name across code and prose, indexable by search engines, ownable by an org rather than a person.
- npm scope `@forge/*` and the workspace dir name are now disambiguated (the npm scope was always brand, the dir was a coincidence).
- The Tauri identifier is no longer pinned to a private internal namespace (`thejunix`).

### Negative

- **Tauri identifier change is breaking for installed alpha users.** macOS Keychain, Windows Credential Manager, and Linux Secret Service all bind credentials to the bundle identifier. Existing v0.1.x installs will be treated as a different application by the OS; auto-update across the identifier change is not guaranteed. Acceptable because the alpha audience is small (<100) and the next release notes will say so explicitly.
- Old URLs work today via 301 redirect, but GitHub does not guarantee redirects forever — a future repo created at `junixlabs/jarvis-agents` would shadow the redirect. Reasonable to monitor; not a near-term concern since `junixlabs` is held by the same owner.
- Documentation referencing the old paths (in CHANGELOG entries, ADRs, RFCs, and proposals) was deliberately *not* rewritten. Those records describe decisions and changes at the time they were made; mechanical search-replace would falsify the historical record. New readers will see "Jarvis Agents" in old ADRs and should treat that as evidence the project predates this ADR.

## Notes

- ADR 0008 said "brand name stays 'Jarvis Agents'" as part of the English-only language decision. That decision (English-only for public artifacts) still stands; only the brand-name claim is superseded here.
- Branding details (visual identity, logo, palette) are still TBD — see [BRAND.md](../BRAND.md). The naming decision above does not depend on those.
- The desktop app version was bumped to `0.1.17` immediately after this rebrand so installed users get the new identifier + URL via the auto-updater chain rather than relying on indefinite redirects.
