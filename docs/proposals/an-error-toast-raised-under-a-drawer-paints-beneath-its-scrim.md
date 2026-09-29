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

Observed in a browser by ISS-1322's judge at `ea73cf8`: after a refused batch release the lane held
`Batch release failed` and `elementFromPoint` at the toast landed inside the drawer's overlay. jsdom
has no stacking or blur, so no unit test here can go red on it.

Walked in code at `7148be6`, for a failure raised only as a toast while a drawer stays open with
nothing inline (each one read in the source, none on screen):

- `features/orgs/components/org-members-card.tsx` — the Rename drawer's `submitRename` toasts
  `Request failed` and stays open.
- `features/settings/components/tokens-tab.tsx` — the Token created drawer's `copyPlaintext` toasts
  `Copy failed`, and `Copied to clipboard`, both beneath it. Token creation is not in a drawer.
- `features/pipeline/components/run-detail.tsx` — Pause, Resume and Stop fail through
  `pipeline/hooks.ts:useRunControl`'s `Run control failed` toast; `copyLink` toasts its own failure.
- `features/session/components/session-screen.tsx` — rendered inside
  `sessions/components/session-reply-panel.tsx`'s drawer (`embedded`), every mutation it runs
  fails through `useToastError` (send, regenerate, fork, edit, cancel, rerun).
- `features/resources/components/private-keys-screen.tsx` — the Test drawer's run fails through
  `useTestSshKey`'s `Couldn't test connection` toast and shows no result.
- `features/integrations/components/connection-edit-drawer.tsx` — `saveKey`, the rename, Activate,
  Deactivate and Remove fail through `useUpdateConnection` and `useRemoveConnection`'s toasts.

Not one: `features/issues/components/new-issue-dialog.tsx` puts a failure in its inline
`errors.form` banner and closes before it toasts. `features/issues/components/batch-release-dialog.tsx`
now says its refusal inline and raises no toast while open (ISS-1322).

Not walked: every other file rendering a `SlideOver` — `conversations-screen.tsx`,
`skill-studio-drawer.tsx`, `add-agent-dialog.tsx`, `conversation-members.tsx`,
`conversation-sidebar.tsx`, `add-person-dialog.tsx`, `new-project-dialog.tsx`,
`issue-quick-actions.tsx`, `transition-reason-dialog.tsx`, `issues-list-view.tsx`,
`module-picker.tsx`, `context-rail.tsx`, `merge-marker-control.tsx`, `device-detail.tsx`,
`project-runners-screen.tsx`, `connection-detail-drawer.tsx`, `integrations-screen.tsx`,
`graph-tab.tsx`, `private-key-create-slideover.tsx`, and the mobile chat drawer in `app/(workspace)/layout.tsx`.

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
| 1, inline per drawer | six drawers found and twenty not walked, and every new drawer has to remember it; nothing enforces it |
| 2, lane above the scrim | a toast covers the bottom of a drawer, including a chat composer's input, for four seconds |
| leaving it | a failure raised under any open drawer stays invisible, and the next report looks like ISS-1322's |
