# The open chat dock makes the page beneath unclickable at 375px

Found while walking ISS-964 criterion 50 on forge-beta (2026-09-09), on
`/projects/sidpeak/agents` at a 375×800 viewport. Not ISS-964's defect and not fixed there: the
dock is `features/session`, which that issue was required to keep rather than rewrite, and this
reproduces on any screen the dock can open over.

## What happens

With the dock open at 375px, every control on the page behind it is **visible but unreachable**.
Playwright's click on `Clear filters` retried for 5s and gave up with

```
<p class="fg-body-sm mx-auto mt-1 max-w-[260px]">Ask the agent anything about this project — it ha…</p>
from <div class="md:hidden">…</div> subtree intercepts pointer events
```

Closing the dock makes the same button reachable immediately (`elementFromPoint` returns the button
rather than the dock's paragraph).

## Why it is a layout collision, not a z-index bug

Measured on the live page: the panel element itself is `0×0`, `position: relative`, `z-index: auto`.
Nothing in the intercepting chain is positioned or stacked — the topmost hit is the dock's own
mobile empty-state text inside `min-h-0 flex-1 overflow-y-auto` at `374×614`. So the dock is a
sibling in normal flow that takes the full viewport width while the page keeps painting underneath
it.

That is the part that reads as broken: a full-screen mobile sheet is a reasonable design, but then
the page behind it should be inert and hidden, not visible and dead to the touch.

## Two shapes of fix, neither chosen here

| | |
|---|---|
| Make it a real sheet | the mobile dock becomes an overlay that covers the page and marks it `inert`, so "behind" stops being a place a finger can aim at |
| Make it a pane | the dock takes a column and the page shrinks beside it, which is what the desktop layout already does |

The second matches the desktop behaviour and needs no new state; the first is fewer lines. Whoever
takes it should also decide what the dock does to page scroll at that width, which was not measured.
