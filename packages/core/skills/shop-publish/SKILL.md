---
name: shop-publish
description: "Publish an Epodsystem storefront: promote the verified DRAFT theme to main (live), clear the storefront cache, and confirm the live URL reflects the change. Use at the release stage of a website-kind project after shop-verify-draft passes. Triggers on: 'publish the storefront', 'go live', promote draft to main, release a theme change."
---

# Shop Publish (release)

Promote the verified draft to live. Only run after `shop-verify-draft` PASSED.

1. Record the **current main `themeId`** first (`forge_storefront_target`) — this is the rollback target for `shop-rollback`. Note it in the release comment.
2. Promote draft → main via `mcp__epodsystem__*` `publish_draft_theme` (uses `draftThemeId`). This is the only step that touches the live theme.
3. Run `clear_storefront_cache` so the change is visible immediately.
4. Confirm: load the **live storefront URL** and verify the change rendered (trap #7 — live URL, not screenshot_preview on main). Re-query menus if they were touched (trap #8).
5. If the live check fails, immediately invoke `shop-rollback` to the recorded prior theme.

Follow [shop-preflight](../shop-preflight/SKILL.md). Report the published theme id + the prior theme id (rollback target).
