# An `fg-*` type class swallows every Tailwind utility on the same element

**Status: OPEN, priced by ISS-1033 (2026-09-17). Needs a design decision, not a refactor.**

`packages/web-v2/src/styles/tokens.css` declares the type scale — `fg-display`, `fg-h1`, `fg-h2`,
`fg-h3`, `fg-body`, `fg-body-sm`, `fg-label`, `fg-caption`, `fg-overline`, `fg-mono`, `fg-code` —
as **unlayered** rules. Tailwind v4 puts every utility it generates inside `@layer utilities`. An
unlayered rule beats a layered one whatever the specificity, so on any element that carries an
`fg-*` class, a Tailwind `color` or `font-weight` utility on the same element does nothing.

The repo already knows this. `packages/web-v2/src/app/globals.css` wraps its base element styles in
`@layer base` and the comment above that block states the rule outright: an unlayered rule beats any
layered utility regardless of specificity, and leaving `:focus-visible` unlayered would override
every per-component `focus-visible:*` ring. The type scale one file over never got the same
treatment.

## What it costs, measured

ISS-1033 shipped a `Waiting` column whose stale rows were meant to read amber and semibold:

```tsx
"fg-caption inline-flex items-center gap-1 font-semibold text-[color:var(--amber-600)] tabular-nums"
```

Measured on beta at `d0389485c` on 2026-09-17, a draft that had not moved in 2 days computed to
`rgb(118, 125, 138)` at `font-weight: 500` — byte-for-byte the muted grey of the row above it that
moved 2 hours ago. `--amber-600` was defined (`#c6790a`) and `.text-\[color\:var\(--amber-600\)\]`
was generated; on a bare span both utilities applied. Beside `fg-caption` neither did. The only
thing left separating a stale row from a fresh one was a 12px clock glyph in the same grey.

This is an affordance defect and not a typo: writing a Tailwind colour utility beside a type class
IS the natural reading of the interface, the change passed review and fourteen gates, and it failed
in the one place nothing asserts — the cascade in a browser.

It is not one call site. Every one of these carries a colour or weight utility on an `fg-*`
element, and none of them is drawing:

- `src/features/issues/components/issue-table-row.tsx` — `RelationChip`, `text-[color:var(--red-600)]` / `text-muted`
- `src/app/(workspace)/projects/[slug]/page.tsx` — three `fg-caption … font-semibold` spans
- `src/features/runners/components/project-runners-screen.tsx` — `fg-caption font-semibold text-accent`
- `src/features/project-dashboard/components/runners-card.tsx` — two `fg-caption … font-semibold`
- `src/features/sessions/components/fleet-strip.tsx` — `fg-caption font-semibold`
- `src/design/patterns/mermaid.tsx`, `src/features/knowledge/components/entry-card.tsx`,
  `src/features/skills/components/smoke-verify-panel.tsx` — `fg-caption … text-red-600`

## Why this is a proposal and not a fix

The one-line fix is to wrap the type scale in `@layer components` in `tokens.css`. Every call site
above would then render what its author wrote — which is the point, and also the problem: that is a
visible restyle of the dashboard, the runners screen, the fleet strip and three error messages, none
of which is ISS-1033's to change and none of whose owners asked for it. Some of those weights and
colours were written years of commits ago against a cascade that swallowed them; nobody has seen
what they look like applied.

So it needs somebody to decide, per surface, whether the intended style is the wanted style, and
that decision cannot be taken from inside an issue about a `Waiting` column.

ISS-1033 paid the local price instead: a `.fg-caption-stale` rule declared beside `.fg-caption`, same
specificity, later in source order, so it wins without moving any layer. That is a workaround, and by
this repo's own rule a workaround that becomes routine is a defect — a second `.fg-*-something`
modifier appearing in `tokens.css` is the signal that this document is overdue rather than open.

## What a fix has to carry

1. The type scale moves into a cascade layer, or every `fg-*` class drops `color` and `font-weight`
   and those become the caller's to state.
2. Each call site above is looked at once with the utility actually applying, and either kept or
   corrected.
3. Something asserts the property afterwards, because nothing in `pnpm verify` or the vitest suites
   can see a cascade: jsdom loads no stylesheet, and a class list that reads correctly is exactly
   what shipped here.

## Honest costs

- **A design review nobody can delegate to a gate.** Each of the nine call sites has to be looked at
  once with the utility actually applying, because none of them has ever been seen that way. That is
  four screens and three error messages, and no rule separates "the author meant this" from "the
  author wrote it and never saw it".
- **The type scale stops being a guarantee.** Today an `fg-*` class means the element renders at
  exactly that step whatever else is written on it. Afterwards any colour or weight utility on the
  element wins, so a stray `text-sm` can move a heading off the scale in silence.
- **A way to assert a computed style, or the same bug again.** The cascade is invisible to every
  check here: `pnpm verify` reads source and vitest runs in jsdom with no stylesheet, so the class
  list that produced a grey stale row reads perfectly. Whoever takes this buys a real-browser
  assertion or accepts that the next swallowed utility is found the way this one was — by somebody
  opening the page.
- **A restyle that ships without an issue behind it.** The surfaces that change are not the ones
  this work is about, so the visible diff lands on screens whose owners did not ask for it and will
  not be looking for it.
