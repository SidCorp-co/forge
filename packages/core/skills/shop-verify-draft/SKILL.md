---
name: shop-verify-draft
description: "Verify Epodsystem storefront changes on the draft theme — load the live/draft URL, assert sections render, links return 200, products/menus bind real data — and FAIL the stage on mismatch. Use at the test stage of a website-kind project. Triggers on: verifying a storefront change, QA of a theme draft, checking a redesign."
---

# Shop Verify Draft (test)

Gate the change against the design spec. This stage MUST fail on mismatch — do not pass on a guess.

1. Resolve the verification surface via `forge_storefront_target`: use the **live storefront URL** (or the draft preview token URL). **Do NOT use `screenshot_preview`** — it is currently unreliable on this integration (404s on main AND draft; see the guide §3) — so it is intentionally ignored here, never a blocker.
2. With Playwright (`mcp__playwright__*`):
   - Navigate the changed pages; assert the spec'd sections actually render (not empty — catches the block-settings/EAV/handle traps).
   - Assert internal links return **HTTP 200** (no 404s in nav/cards).
   - Assert products/collections/menus bind **real data**, not placeholders.
   - Screenshot each checked surface as evidence.
3. PASS only if every spec item renders correctly. Otherwise FAIL with the specific mismatch (which section/product/link) so `shop-customize-draft`/`shop-products`/`shop-menus` can fix it.

Follow [shop-preflight](../shop-preflight/SKILL.md). Publishing (`shop-publish`) only runs after this passes.
