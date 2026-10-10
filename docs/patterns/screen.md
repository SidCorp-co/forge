# Screen

**Change kind:** Screen
**Introduced by:** ISS-466

A page or a component of `packages/web-v2`, under `src/features/<module>/`. A screen renders what a
core read answers and sends what a core route takes; it computes no domain fact of its own. A
change takes this entry when it adds or changes a page, a panel, a form or the words on one. It
builds on [API route](api-route.md) for the reads and writes it calls, and on
[Core module](core-module.md) (Web module, Read models) for where every derived fact comes from.

## Reference

- `packages/web-v2/src/features/suggestions/api.ts` — fetchers over `apiClient`, one per route, typed from contracts
- `packages/web-v2/src/features/suggestions/hooks.ts` — React Query hooks: one query key per read, and a mutation that invalidates what its effect changes
- `packages/web-v2/src/features/suggestions/types.ts` — re-exports from `@forge/contracts`, plus UI-local unions only
- `packages/web-v2/src/features/suggestions/components/suggestion-list.tsx` — a component that reads through the hooks, draws refusals with `RefusalLine` and words through the copy readers
- `packages/web-v2/src/lib/api/refusals.ts` — `refusalsOf`, `namedRefusals`: every refusal a screen shows is read from the envelope
- `packages/web-v2/src/design/primitives/enum-badge.tsx` — `StatusBadge` and `EnumBadge`, the only badges, drawing tones declared in contracts
- `packages/web-v2/src/lib/i18n/product-copy.ts` — `productCopy`: a feature's words come from its copy file, written in English only (owner ruling, ISS-403)

## Test shape

- `packages/web-v2/src/features/suggestions/components/suggestion-list.test.tsx` — the component rendered with `renderWithQuery` over a `fakeCore` that answers what core answers, asserting what a person sees and what a click sends
- `packages/web-v2/src/test/en-only-copy.test.tsx` — a key with English only reads its English on a Vietnamese page, with no raw key and no blank

A new screen gets a `*.test.tsx` beside its component, collected by `packages/web-v2/vitest.config.ts`
under jsdom (`pnpm --filter web-v2 test`). It renders the component with
`packages/web-v2/src/test/render.tsx:renderWithQuery`, stubs core with `fakeCore` answering the
contracts shape the read model serves, and asserts on text and roles a person meets: the rows
shown, the refusal line for a refused write, the request body a button sends. It never asserts a
class name or a copy key. The direct tests of a screen change are the test files of the components
it touched.

## Review checklist

1. The feature keeps the module layout: **api.ts**, **hooks.ts**, **types.ts**, **components/**, and **routes.ts** only where it owns pages.
2. Every fact the screen shows comes from a core read; **derive.ts** only formats, sorts and groups.
3. Types come from `@forge/contracts`; no shape core answers is redeclared by hand.
4. A refused write is drawn from the refusal envelope (`refusalsOf`, `namedRefusals`, `RefusalLine`), naming the code's sentence, never a generic error.
5. Badges use `StatusBadge` or `EnumBadge` with tones from contracts; the feature declares no colour map.
6. New words are copy keys in English only; none is written inline in the component, and no Vietnamese is added. Each obeys the Copy rule above: at most 12 words, and the page it lands on stays inside the first-screen budget.
7. A mutation invalidates every query its effect changes.
8. The screen is reachable: a route or a parent component renders it, and it works at phone width.

## Copy rule

Every person-facing page reads as state, not prose (owner, 2026-10-10: "UI full of text is garbage").
The same rule is project knowledge `ui-copy-rule`, which every agent run reads: a core-built prompt
carries it, and so does the checkout orientation a box writes for the runs a master declares
(`packages/core/src/prompt/checkout-orientation.ts:checkoutOrientation`).

1. A page opens on what is true now: properties and short rows. A label is 1-3 words; a row or value at most 12 words.
2. No explaining copy. No sentence tells the reader what a section is, what a button does, who can see something, or what will happen later. If a control needs a sentence, change the control.
3. Each fact once per page. No repeated status, warning or count.
4. Empty is one word: "Nothing", "None", "No runs".
5. Verdicts and states are a mark or a colour plus one word; counts live in the filter, not on every row.
6. Agent text (plans, rounds, file lists, paths, shas, BC codes, function names, refusal codes) sits folded behind a Developer view, never the default.
7. Past and voided items go to Activity, not the top.
8. Budget: the first screen at 1440x900 shows at most 300 words; a copy string is at most 12 words (refusals and confirmations 20). A longer string is a defect, not a style choice.

Held by `scripts/check-copy-budget.mjs` (the `language` axis): a copy string over budget is refused
naming its file, key and word count, with no baseline. The sentences core writes for pages
(`packages/contracts/src/said-keys.ts`) are held to the same budget. What a key is comes from its name, by the
conventions `checkers.copy-budget` in `.forge/conformance.json` declares: a refusal or
confirmation when a segment matches `refusalSegments` (20 words); an empty state when its last
segment matches `emptySegments` (2 words, rule 4); an explanation when its last segment matches
`explainSegments` (`hint`, `intro`, `help` and the like), refused at any length (rule 2). A label
is never keyed as a hint. `ViewHeading`, `ListGroup` and `PageTitle` take no explaining line. The first-screen budget is held for the issue page
by `packages/web-v2/src/features/issues/components/issue-detail-screen.test.tsx`, whose page is the
reference for rules 1, 3, 5, 6 and 7.
