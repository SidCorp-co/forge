# An error toast raised while a drawer is open paints beneath the drawer's scrim

Found while working ISS-1322, where the refused batch release was this mechanism: the hook's
`Batch release failed` toast fired, carrying the server's sentence, and nobody saw it. ISS-1322
fixed that one drawer by saying the refusal inside it. The mechanism is every drawer's, and ISS-1322's
out-of-scope clause excludes other mutations' error surfacing, so it is recorded here rather than
changed.

## What is measured

- `providers/toast-provider.tsx:ToastLane` is an in-flow section after the workspace `<main>`
  (`app/(workspace)/layout.tsx`), with no positioning and no z-index. It was made in-flow on purpose
  (ISS-1148), so no page content sits under a toast.
- `design/patterns/slide-over.tsx:SlideOver` is `fixed inset-0 z-50`, with a scrim and an 8px
  backdrop blur over the whole viewport.
- So a toast raised while a drawer is open is painted under the blurred scrim for its four seconds.
  Where the drawer also stays unchanged on failure, the press reads as accepted.

Derived from the CSS, not observed in a browser: jsdom has no stacking or blur, so no unit test here
can go red on it. Proof needs a rendered page.

Drawers counted at `55f99a1e` that raise an `error` toast or carry an `onError` while a `SlideOver`
may be open, and so may be hiding a failure the same way (a count of sites, not a count of confirmed
defects — each one closes itself on failure or not):
`features/orgs/components/org-members-card.tsx`, `features/settings/components/tokens-tab.tsx`,
`features/pipeline/components/run-detail.tsx`, `features/session/components/session-screen.tsx`,
`features/resources/components/private-keys-screen.tsx`, `features/issues/components/new-issue-dialog.tsx`,
`features/integrations/components/connection-edit-drawer.tsx`.

## The choice nobody has made

1. **A drawer says its own failure inline**, as `new-project-dialog.tsx` and now
   `batch-release-dialog.tsx` do, and a toast stays for what happens outside any drawer. Each drawer
   is audited once.
2. **The lane paints above a modal scrim while one is open**, so every toast is seen wherever it was
   raised. One change in `ToastLane`, but it overlaps the bottom of a drawer, which ISS-1148 chose to
   avoid for page content.

## Honest costs

| Choice | Cost |
|---|---|
| 1, inline per drawer | seven drawers to audit, and every new drawer has to remember it; nothing enforces it |
| 2, lane above the scrim | a toast covers the bottom of a drawer, including a chat composer's input, for four seconds |
| leaving it | a failure raised under any open drawer stays invisible, and the next report looks like ISS-1322's |
