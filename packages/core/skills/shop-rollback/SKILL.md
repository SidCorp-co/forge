---
name: shop-rollback
description: "Roll back an Epodsystem storefront by re-activating the previously-live theme when a publish goes wrong. Use at the fix stage of a website-kind project, or invoked by shop-publish on a failed live check. Triggers on: 'roll back the storefront', 'revert the theme', publish broke the live site."
---

# Shop Rollback (fix)

Restore the previous live theme. Rollback = re-activate the theme that was main **before** the last publish (there is no destructive delete).

1. Find the prior main `themeId` — from the `shop-publish` release note (it records the rollback target) or the theme history via `mcp__epodsystem__*`.
2. Re-activate that theme as main (publish the prior theme back to live).
3. Run `clear_storefront_cache`.
4. Confirm the **live storefront URL** shows the restored state (trap #7).
5. Leave the broken draft intact for re-work in `shop-customize-draft` — do not discard it.

Follow [shop-preflight](../shop-preflight/SKILL.md). Report which theme is now live.
