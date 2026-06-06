---
name: shop-rollback
description: "Roll back an Epodsystem storefront after a bad publish by re-publishing the independent backup theme that shop-publish retained (NOT by re-activating the old main id — publishing can destroy it). Use at the fix stage of a website-kind project, or invoked by shop-publish on a failed live check. Triggers on: 'roll back the storefront', 'revert the theme', publish broke the live site."
---

# Shop Rollback (fix)

Restore the last known-good live storefront after a publish went wrong.

> **Mechanics are owned by Epodsystem and change over time.** Do NOT hardcode a
> rollback sequence. Load the current method from the LIVE service first —
> `get_skill shop-core-rules` / `list_skills` via `mcp__epodsystem__*` — and
> follow it. The steps below are the **durable Forge invariants**; the live
> playbook supplies the exact tool calls.

Rollback = **re-publish the independent backup theme that `shop-publish` created
and recorded BEFORE the publish** — not "re-activate the previous main".

1. Get the backup `themeId` from the `shop-publish` release comment (it records
   the retained rollback target).
   - **Do NOT try to re-activate the old main id.** Promotion can destroy/replace
     the prior main, so that id may no longer exist (verified live: `storeTheme`
     for the consumed theme returned `null`). Only the retained backup is a safe
     target.
   - If no backup id was recorded (e.g. an older publish predating this rule),
     fall back to the service's **current** restore mechanism — e.g. theme
     file-version restore (`published_files_version_id`) — discovered at runtime
     via the Epodsystem MCP. Never assume a deleted theme is re-activatable.
2. Re-publish that backup theme to main using the current Epodsystem publish tool.
3. Run `clear_storefront_cache`.
4. Confirm the **live storefront URL** shows the restored state (trap #7 — live
   URL, not `screenshot_preview` on main).
5. Leave the broken draft intact for re-work in `shop-customize-draft` — do not
   discard it.

Follow [shop-preflight](../shop-preflight/SKILL.md). Report which theme is now live.
