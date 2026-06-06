---
name: shop-preflight
description: "Forge⇄Epodsystem integration guide — the thin Forge-owned layer that sits ON TOP of Epodsystem's live single-source playbooks. Defers build mechanics to the live shop-core-rules, holds Forge's durable invariants (build-on-draft, backup-before-publish, verify-via-live-URL), and records how Forge routes around current service quirks so a quirk degrades instead of hard-failing. Referenced by shop-customize-draft, shop-products, shop-menus, shop-verify-draft, shop-publish, shop-rollback. Triggers on: any Epodsystem theme/store mutation, 'customize storefront', 'edit theme', 'add products', 'change menu'."
---

# Forge ⇄ Epodsystem integration guide

Forge's **thin guide layer** over Epodsystem. It exists so Forge can run Epod
storefronts through the pipeline reliably AND proactively improve the way the
user works — without forking Epodsystem's docs. Read this before any `shop-*`
stage. It has three parts: what to defer, what Forge guarantees, how Forge
handles current quirks.

First resolve context with `forge_storefront_target` → `storeSlug`, `storeName`,
`themeId` (live/main), `draftThemeId` (draft/staging), `commerceEnabled`,
`endpoint`. The `crmk_` key is never exposed — it is injected into the
`mcp__epodsystem__*` tools automatically.

## §1 — Single source of truth = the LIVE Epodsystem playbooks (do NOT duplicate)
All build/redesign mechanics (palette tokens, the design contract, render rules,
how to bind live data, image re-hosting) live in Epodsystem's own
`shop-core-rules` — it is the maintained single source. **Load it live at runtime**
with `get_skill shop-core-rules` (and the focused playbook for the task:
`shop-redesign`, `shop-build-section`, `shop-create-product`, …) via the
`mcp__epodsystem__*` server. Do not copy its steps into Forge — when Epodsystem
updates, the live skill updates and Forge tracks it automatically.

## §2 — Forge durable invariants (Forge owns these; independent of the service)
These hold no matter how Epodsystem implements themes — they never rot:
1. **Build on the DRAFT theme** (`draftThemeId`), never on main. Main is touched
   only by `shop-publish`.
2. **Backup-before-publish.** `shop-publish` snapshots the current live main into
   an INDEPENDENT retained theme before promoting, and records its id as the
   rollback target (publishing can consume/replace the old main — verified live:
   `storeTheme(485)=null` after promotion). `shop-rollback` re-publishes that
   backup, never "re-activates the old id".
3. **Verify on the LIVE storefront URL** (+ Playwright), not on a render-preview.
4. **One store per project.** staging ↔ draft theme, prod ↔ main theme; publish
   promotes draft → main on the same store; no second store/key.
5. If a precondition is unmet (no active integration, no `draftThemeId`), STOP
   and report — never mutate main.

## §3 — Current service quirks + how Forge routes around them
Forge-discovered, **pending upstream** (report so they fold into `shop-core-rules`).
Treat as "degrade, don't hard-fail"; re-verify each before trusting — they may be
fixed already. When a quirk is gone, delete its line here.
- **`screenshot_preview` unreliable → IGNORE it.** Verified live: it returns
  "404 page not found" on both main and draft. **Do not block on it.** Verify via
  the **live storefront URL + Playwright** instead (this overrides
  `shop-core-rules` §D's screenshot step for the Forge pipeline).
- **Publish consumes the prior main** → §2.2 backup-before-publish (already handled).
- **Menus go stale** → after mutating a menu, re-query `storeMenu(id){ items }`;
  don't trust the mutation response.
- **Theme cloning**: prefer `duplicateTheme`/`customize_theme` to get a working
  draft (historically `createTheme` was broken — re-verify).
- Other historical traps (block-settings not reaching Liquid; smart-collection
  `conditions_serialized`/`include_ids`; product grids need EAV
  `image`/`thumbnail`/`small_image` + reindex; cards need `handle`+`featured_image`;
  `draft status 0` ≠ hidden): consult the live `shop-core-rules` first; only apply
  the workaround if you actually hit the symptom.

## §4 — Proactive improvement (the point of this layer)
This file is where Forge captures **optimal-usage learnings** for the user as we
run Epod in the pipeline — new guards, better defaults, UX shortcuts. When you
discover a quirk or a better way: (a) add a short, verified line to §3/§2, (b)
report it upstream to Epodsystem so the single source converges, (c) remove it
here once upstream covers it. Keep this layer THIN — invariants + deltas only,
never a second copy of the playbook.
