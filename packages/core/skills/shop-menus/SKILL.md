---
name: shop-menus
description: "Edit Epodsystem store navigation menus reliably, working around the stale-storeMenu read bug (always re-query after mutating). Use at the code stage of a website-kind project. Triggers on: 'change the menu', adding/removing nav items, reordering navigation."
---

# Shop Menus (code)

Mutate store navigation. The backend returns stale menu state after a write, so always read back.

1. Resolve the menu id (`forge_storefront_target` + `mcp__epodsystem__*` menu list).
2. Apply the menu change (add/remove/reorder items) via the shop MCP tools.
3. **Re-query `storeMenu(id){ items }` after the mutation** (trap #8) — the mutation response is unreliable; trust only the fresh read.
4. Confirm item targets resolve (collections/pages by `handle`, trap #4).

Follow [shop-preflight](../shop-preflight/SKILL.md). Menu changes apply to the store; verify rendering in `shop-verify-draft` against the live/draft URL.
