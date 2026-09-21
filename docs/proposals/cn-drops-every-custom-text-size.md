# `cn()` silently drops every custom text-size utility next to a colour utility

Found by ISS-1119, measuring the compact nav rail in a real browser to prove the version line is
painted. Not fixed there: the fix is one line and its effect is every screen in `packages/web-v2`.

`cn()` in `packages/web-v2/src/lib/utils/cn.ts` is `twMerge(clsx(...))`. `tailwind-merge` resolves
conflicts inside a class group by keeping the last member. It does not know this repo's type ramp —
the sixteen `--text-*` steps declared in `@theme` in `packages/web-v2/src/app/globals.css` — so it
reads `text-9-5`, `text-13` and every other step as a **colour** and puts it in the same group as
`text-muted`, `text-fg` and `text-subtle`. Whichever is written last wins, and the other is deleted
from the string before it ever reaches the DOM.

Measured against the installed `tailwind-merge`:

| Written | Emitted |
|---|---|
| `cn('text-9-5 font-semibold tracking-[-0.01em]', 'text-muted')` | `font-semibold tracking-[-0.01em] text-muted` |
| `cn('text-8-5 font-semibold uppercase text-subtle')` | `font-semibold uppercase text-subtle` |
| `cn('text-13 text-fg')` | `text-fg` |
| `cn('text-muted', 'text-9-5 leading-tight')` | `text-9-5 leading-tight` |

Only the last shape survives, so whether a declared size reaches the browser depends on which side
of the call the colour happens to sit on.

This is visible in production today. `packages/web-v2/src/features/shell/nav-rail-compact.tsx`
opens by describing "an icon over a 9.5px label"; every one of those labels renders at the 15px body
size, and `Dashboard`, `Automation` and `Conversations` spill past the 76px rail. The judging run's
own screenshot of the beta deployment at 1366x768, attached to ISS-1119 as
`iss1119-592637d-compact-rail-1366x768.png`, shows all three clipped. The one string in that rail
that *is* the size it asks for is the Forge version, because `ForgeVersion` writes the colour first
and the caller's size second — the fourth row of the table.

The fix is `extendTailwindMerge` with the ramp's sixteen steps declared as the `font-size` group, in
that one file. What makes it a proposal rather than an edit is what happens next: every place in the
app that has been reading at the inherited size starts reading at the size it declares, all at once,
on screens nobody has looked at. That is a typography change wearing a bug fix's clothes, and it
wants its own issue, its own before-and-after captures and its own judging pass.

ISS-1119 deliberately left the rail's labels alone for the same reason. Fixing that one file would
have made the default navigation the only surface in the product where the ramp is honoured, which
is a third state rather than a repair.

## Honest costs

The price of doing this, not of leaving it:

| Cost | What it takes |
|---|---|
| Every screen changes at once, unseen | The whole point of the fix is that declared sizes start applying. Nobody knows how many elements that is without running it, and the diff is one line, so the review cannot show the change — only the screenshots can. Somebody has to walk the product. |
| Some of those sizes are wrong | A size written years ago and never rendered has never been judged. Turning them all on surfaces the ones that were typed badly, and each becomes a small decision about what the element should read at. |
| The ramp becomes a coupling | Today a step can be added to `@theme` on its own. After this, the step has to be added in two places, and a step present in one and absent from the other silently returns to the current behaviour for that step alone — the same failure, harder to spot. |
| It costs a round on something nobody has reported | The product has shipped this way throughout. No user has filed it, and the compact rail is legible, if not as designed. Spending here is spending ahead of evidence. |
| A partial fix is a third state | Correcting the sizes in one file, as ISS-1119 could have, leaves one surface honouring the ramp and the rest not. That is worse than either end for whoever reads the code next. |
