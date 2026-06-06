---
name: shop-publish
description: "Publish an Epodsystem storefront: snapshot the current live theme as a rollback backup, promote the verified DRAFT theme to main (live), clear the storefront cache, and confirm the live URL reflects the change. Use at the release stage of a website-kind project after shop-verify-draft passes. Triggers on: 'publish the storefront', 'go live', promote draft to main, release a theme change."
---

# Shop Publish (release)

Promote the verified draft to live — only after `shop-verify-draft` PASSED.

> **Mechanics are owned by Epodsystem and change over time.** Do NOT assume a
> fixed publish sequence or tool name. Load the current canonical method from the
> LIVE service first — `list_skills` / `get_skill shop-core-rules` (and
> `shop-redesign`) via the `mcp__epodsystem__*` server — and follow it. The
> numbered steps below are the **durable Forge invariants** that must hold no
> matter how Epodsystem implements themes; the live playbook supplies the exact
> tool calls.

1. **Snapshot the current live main as an INDEPENDENT backup BEFORE publishing.**
   Duplicate the current main theme into its own retained, unpublished theme —
   a separate copy, **not** the draft you are about to promote. Record this
   backup `themeId` in the release comment: it is the rollback target for
   `shop-rollback`.
   - Why: publishing can **consume/replace** the prior main — the old main
     `themeId` may disappear entirely after promotion (verified live: publishing
     a draft cloned from theme 485 left `storeTheme(485) = null`). So the rollback
     target must be a copy **you kept**, never "the id that used to be main".
2. Promote the verified draft → main using the current Epodsystem publish tool.
   This is the only step that touches the live theme.
3. Run `clear_storefront_cache` so the change is visible immediately.
4. Verify on the **live storefront URL** that the change rendered (trap #7 — live
   URL, never `screenshot_preview` on main). Re-query menus if they were touched
   (trap #8).
5. If the live check fails → immediately invoke `shop-rollback` with the backup
   `themeId` from step 1.

Follow [shop-preflight](../shop-preflight/SKILL.md). Report the published theme id **and** the retained backup theme id (the rollback target).
