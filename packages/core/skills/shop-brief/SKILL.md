---
name: shop-brief
description: "Triage an Epodsystem storefront issue: read the brief, pull store context, and inventory the current theme/products/menus so planning starts from real state. Use at the triage stage of a website-kind project. Triggers on: storefront/website issues, 'redesign the shop', 'add products', 'new landing page', 'change palette'."
---

# Shop Brief (triage)

First step for a `website`-kind project. Goal: turn a storefront request into an actionable, scoped brief grounded in the store's real state.

1. Call `forge_storefront_target` for store context (slug/name/theme ids/commerceEnabled/endpoint). If `configured:false`, set `needs_info` — the project has no active Epodsystem integration.
2. Inventory current state via `mcp__epodsystem__*`: active theme + draft theme, top-level collections, product count, menus. Note what the request will touch.
3. Classify scope (single section / full redesign / N products / new landing / palette) and flag anything ambiguous for clarify.
4. Respect [shop-preflight](../shop-preflight/SKILL.md) — especially: build target is the DRAFT theme; commerce features only exist when `commerceEnabled`.

Keep it cheap — no theme mutation at triage. Hand a concrete inventory + scope to clarify.
