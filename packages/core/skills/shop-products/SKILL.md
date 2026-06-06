---
name: shop-products
description: "Add or update Epodsystem products and collections so they render correctly in grids and cards (EAV images + reindex, smart-collection rules, visibility). Use at the code stage of an ecommerce website-kind project. Triggers on: 'add N products', updating a collection, fixing products that don't show in a grid."
---

# Shop Products (code)

Create/update products + collections on the store so they render. Most "product not showing" issues are the EAV/handle traps below.

1. Confirm `commerceEnabled` via `forge_storefront_target` — skip for blog/landing stores.
2. Create/update products via `mcp__epodsystem__*`. For a product to appear in a **grid**, set the EAV `image`, `thumbnail`, AND `small_image` attributes, then **reindex** (trap #3) — missing any → blank tile.
3. For **cards**, set both `handle` and `featured_image` (trap #4).
4. Visibility: do NOT rely on `draft status 0` to hide a product (trap #5) — use the explicit visibility/disable flag.
5. **Smart collections**: set `conditions_serialized` (or explicit `include_ids`) directly — do not drive the rule UI (trap #2).
6. After collection/menu-affecting changes, re-query to confirm real state (trap #8).

Follow [shop-preflight](../shop-preflight/SKILL.md). Work against the draft-theme storefront; verification happens in `shop-verify-draft`.
