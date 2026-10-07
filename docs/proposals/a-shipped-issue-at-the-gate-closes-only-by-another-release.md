# A shipped issue at the release gate closes only by another release

Found in ISS-1381 r3. When a release batch ships and its finish cannot close one issue, that issue
goes back to `awaiting_release` with its code already live
(`packages/core/src/release-batch/releasing-recovery.ts:recoverStrandedReleasing`). Once the
person clears the refusal, the issue page offers one way to close it: Release now on its release
banner (`packages/web-v2/src/features/issues/components/awaiting-release-banner.tsx`), which starts
a new release that ships the same code again, or leaving it for the next release.

Two acts a person might expect are not in the product:

- **Closing it against the release that already shipped it.** The status menu draws
  `packages/core/src/pipeline/state-machine.ts:transitions`, whose `awaiting_release` row holds no
  `closed`. Core accepts the move from a person (`canTransitionFree`), and
  `POST /api/projects/:id/release-records` records a release that happened outside a batch, but no
  screen sends either.
- **Withdrawing an open question without answering it.** `POST /api/questions/:id/void` exists; no
  screen calls it, and the status menu's withdraw prompt opens only on a terminal move the menu
  offers, which from the gate is `dropped`.

The choice nobody has made: give the person one of these acts at the gate, or keep the gate's only
exit a release. Widening the transition is a kernel change (`VISION: kernel-hard-policy-soft`) and
the owner's to decide.

## Honest costs

| Choice | Cost |
|---|---|
| a Closed entry at the gate, asking which release shipped it | a hand close can claim a release that never served the code; it needs the release-record evidence the API demands, or `closed` stops meaning shipped |
| a withdraw act on the Decision waiting card | a question withdrawn instead of answered loses the decision it asked for; the card has to ask why, as the status move does |
| leaving it | every returned issue costs another release to close, which redeploys code that is already live |
