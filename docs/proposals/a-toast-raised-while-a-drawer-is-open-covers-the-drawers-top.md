# A toast raised while a drawer is open covers the drawer's top

Found while working ISS-1322, where a refused batch release raised `Batch release failed` under the
drawer's scrim and nobody saw it. ISS-1322 fixed that one drawer by saying the refusal inside it. Of
the two choices this proposal first offered, the second has since been taken: ISS-1289 put the toast
lane above the scrim. What it costs, and what is still open, is below.

## What is measured

- `providers/toast-provider.tsx:ToastLane` renders through a portal on `<body>` at `z-[60]`, fixed to
  the top edge: full width on a phone, right-aligned below the top bar (`md:top-14`) from `md` up.
- `design/patterns/slide-over.tsx:SlideOver` is a portal on `<body>` at `z-50`, a full-width panel on
  a phone and a right-hand panel from `sm` up, with a scrim over the rest.
- So a toast raised while a drawer is open is seen, and it sits over the drawer's top for its four
  seconds: the title on a phone, the first lines of the body at 1280.

Observed in a browser by ISS-1289 at `a05c2d2`: on the Token created drawer, `elementFromPoint` on
the panel's first line and on the token code landed in the toast lane at 1280, and on the drawer's
title at 390. ISS-1289 moved that drawer's copy result onto its own button and dismisses the form's
notices as the drawer opens, so it raises no toast while open.

Walked in code at `7148be6`, and still raising toasts at `8cad693`, for a result raised only as a
toast while a drawer stays open (each read in the source, none on screen):

- `features/orgs/components/org-members-card.tsx` — the Rename drawer's `submitRename`.
- `features/runs/components/run-detail.tsx` — Pause, Resume and Stop through
  `runs/hooks.ts:useRunControl`; `copyLink`'s own failure.
- `features/session/components/session-screen.tsx` — inside
  `sessions/components/session-reply-panel.tsx`'s drawer, the mutations `session/hooks.ts` builds
  on `useToastError`, and its own Copy link.
- `features/resources/components/private-keys-screen.tsx` — the Test drawer through
  `resources/hooks.ts:useTestSshKey`.
- `features/integrations/components/connection-edit-drawer.tsx` — `saveKey`, the rename, Activate,
  Deactivate and Remove through `useUpdateConnection` and `useRemoveConnection`.

Not walked: every other drawer, and everything rendered inside one. `grep -rlE '<SlideOver'
packages/web-v2/src --include='*.tsx'`, test files aside, lists the components that render a drawer
themselves; callers of `ConfirmDialog`, `BatchReleaseDialog`, `TransitionReasonDialog` and
`NewIssueDialog` open one without matching it. An audit of one drawer reads every component it renders.

## The choice still open

Whether each drawer says its own result inline, as `new-issue-dialog.tsx`, `batch-release-dialog.tsx`
and the Token created drawer do, so that no toast covers the drawer it is about; or whether the lane
keeps clear of an open right-hand drawer, which needs the lane to know the drawer's width.

## Honest costs

| Choice | Cost |
|---|---|
| inline per drawer | five drawers above and the rest not walked; every new drawer has to remember it, and nothing enforces it |
| lane clear of the drawer | the lane reads the open drawer's width, a coupling between two layers that today know nothing of each other |
| leaving it | a toast covers a drawer's title or first lines for four seconds whenever one is raised over it |
