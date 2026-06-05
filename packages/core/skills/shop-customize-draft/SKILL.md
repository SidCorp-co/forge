---
name: shop-customize-draft
description: "Build Epodsystem storefront changes on the DRAFT theme — sections, layout, palette, typography — via the shop MCP tools. Use at the code stage of a website-kind project. Triggers on: implementing a storefront redesign, editing theme sections, applying a palette, customize_theme."
---

# Shop Customize Draft (code)

Implement the design spec on the **draft theme only**. Never touch the main/live theme here (trap #9; main is `shop-publish`'s job).

1. `forge_storefront_target` → resolve `draftThemeId`. If absent, create the draft with `duplicateTheme` from the current main (trap #6 — never `createTheme`).
2. Apply changes via `mcp__epodsystem__*` `customize_theme` against `draftThemeId`:
   - Configurable values → **section settings**, never block settings (trap #1).
   - Palette/typography → theme settings on the draft.
3. Keep edits scoped to the spec; re-read state after each mutation that the backend reports stale (menus especially — trap #8).
4. Do NOT publish. Leave the draft ready for `shop-verify-draft`.

Follow [shop-preflight](../shop-preflight/SKILL.md). Hand off the draft theme id + a list of changed surfaces for verification.
