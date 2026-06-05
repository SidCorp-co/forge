---
name: shop-preflight
description: "Epodsystem storefront preflight guardrails — the 10 traps every shop-* skill must respect before mutating a theme, collection, product grid, or menu. Use as the shared checklist referenced by shop-customize-draft, shop-products, shop-menus, shop-verify-draft, shop-publish, and shop-rollback. Triggers on: any Epodsystem theme/store mutation, 'customize storefront', 'edit theme', 'add products', 'change menu'."
---

# Shop Preflight — Epodsystem guardrails

Shared guardrails for every `shop-*` skill. The Epodsystem backend has known unfixed bugs; these rules route around them at the skill/tool level. **Never** attempt to fix the backend — work within these constraints.

Read store + theme context first with `forge_storefront_target` (returns `storeSlug`, `storeName`, `themeId` = live/main, `draftThemeId` = draft/staging, `commerceEnabled`, `endpoint`). The `crmk_` key is never exposed — it is injected into the `mcp__epodsystem__*` tools automatically.

## The 10 traps (productized)

1. **Block settings do not reach Liquid.** Put configurable values in **section settings**, not block settings — block settings silently fail to render.
2. **Smart collections** — never edit rule UIs; set `conditions_serialized` directly, or use explicit `include_ids` for a manual set.
3. **Product grids need EAV image attributes.** A product only renders in a grid when `image`, `thumbnail`, and `small_image` EAV attributes are set — then **reindex**. Missing any → blank tile.
4. **Cards resolve by `handle` + `featured_image`** — set both; an id-only reference renders an empty card.
5. **`draft status 0` does NOT hide a product.** Draft status is not a visibility toggle — use the explicit visibility/disable flag instead.
6. **Use `duplicateTheme`, never `createTheme`.** `createTheme` is broken — clone the current theme with `duplicateTheme` to get a working draft.
7. **Verify on the LIVE URL, never `screenshot_preview` on theme main** — `screenshot_preview` is unreliable on the main theme. Verify against the live storefront URL (or the draft preview token).
8. **Menus go stale.** After mutating a menu, re-query `storeMenu(id){ items }` to read back the real state — do not trust the mutation response.
9. **Always build on the DRAFT theme** (`draftThemeId`), never on main. Main is touched only by `shop-publish`.
10. **One store per project.** staging ↔ draft theme, prod ↔ main theme. Publishing promotes draft → main on the same store; there is no second store/key.

If any precondition is unmet (no active integration, no `draftThemeId`), stop and report — do not mutate main.
