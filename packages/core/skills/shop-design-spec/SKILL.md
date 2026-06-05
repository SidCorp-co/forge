---
name: shop-design-spec
description: "Clarify an Epodsystem storefront issue into a concrete design spec (sections, products, menus, palette) and confirm the draft-theme build target before coding. Use at the clarify stage of a website-kind project. Triggers on: storefront design clarification, 'what should the page look like', verifying a redesign brief."
---

# Shop Design Spec (clarify)

Turn the brief into a buildable spec so `shop-customize-draft` has no ambiguity.

1. Re-read store context (`forge_storefront_target`) and the triage inventory.
2. Produce a design spec: which sections change, section settings to set (NOT block settings — trap #1), products/collections affected, menu changes, palette/typography.
3. Confirm the build target is the **draft theme** (`draftThemeId`). If there is no draft theme, plan to create one via `duplicateTheme` (trap #6) — never `createTheme`.
4. For ecommerce stores, confirm product visibility expectations (trap #5: `draft status 0` does not hide) and grid image requirements (trap #3: EAV `image`/`thumbnail`/`small_image` + reindex).
5. Capture a verification plan for `shop-verify-draft` (which live URLs / which elements must render).

Follow [shop-preflight](../shop-preflight/SKILL.md). Output a spec the code stage can execute without re-deciding.
