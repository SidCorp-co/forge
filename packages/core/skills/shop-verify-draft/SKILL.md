---
name: shop-verify-draft
description: "Verify Epodsystem storefront changes on the draft theme — load the live/draft URL, assert sections render, links return 200, products/menus bind real data — and FAIL the stage on mismatch. Use at the test stage of a website-kind project. Triggers on: verifying a storefront change, QA of a theme draft, checking a redesign."
---

# Shop Verify Draft (test)

Gate the change against the design spec, **on the DRAFT, before publish**. This stage MUST fail on mismatch — do not pass on a guess.

1. Build the **draft preview URL** (this is how you see the draft without publishing — the domain is the published domain plus a token param, NOT a separate host):
   - `forge_storefront_target` → real `domain` + the `draftThemeId` you built on.
   - `create_theme_preview(draftThemeId)` → `{ token, expires_at }` (TTL ~1h).
   - Preview URL = **`https://<domain>/?preview_token=<token>`** (append `&preview_token=…` for non-root paths). Verified: this renders the draft live; the `screenshot_preview` MCP tool is the broken bit (404s) — **ignore it**, drive the preview URL with Playwright instead (guide §3).
2. With Playwright (`mcp__playwright__*`) against the preview URL:
   - Navigate the changed pages; assert the spec'd sections actually render (not empty — catches the block-settings/EAV/handle traps).
   - Assert internal links return **HTTP 200** (no 404s in nav/cards). Carry the `preview_token` on internal hops so they stay on the draft.
   - Assert products/collections/menus bind **real data**, not placeholders.
   - Screenshot each checked surface as evidence.
3. PASS only if every spec item renders correctly. Otherwise FAIL with the specific mismatch (which section/product/link) so `shop-customize-draft`/`shop-products`/`shop-menus` can fix it. (Tokens expire — regenerate with `create_theme_preview` if a run runs long.)

Follow [shop-preflight](../shop-preflight/SKILL.md). Publishing (`shop-publish`) only runs after this passes.
