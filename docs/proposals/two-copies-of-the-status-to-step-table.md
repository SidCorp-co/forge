# Two copies of the status-to-step table, and they already disagree

Found by ISS-1097's source scan, which was looking for a second kernel-status-to-**word** map and
turned these up instead. Not fixed there: they are a different vocabulary from the one that issue
owns, and changing them reaches the skills feature and the API error surface.

Two files each map eight kernel statuses to the pipeline **step** that status dispatches, by hand:

- `packages/web-v2/src/features/skills/types.ts` — `open: "Triage"`, `confirmed: "Clarify"`,
  `clarified: "Plan"`, `approved: "Code"`, `developed: "Review"`, `testing: "Test"`,
  `reopen: "Fix"`, `awaiting_release: "Release"`.
- `packages/web-v2/src/lib/api/error.ts` — the same eight keys, prefixed: `"Auto triage"`,
  `"Auto clarify"`, `"Auto plan"`, `"Auto code"`, `"Auto review"`, `"Auto test"`, `"Auto fix"`,
  `"Auto release"`.

Neither derives from the other and neither derives from the pipeline registry, so a step renamed or
a status added reaches one and not the other. That is the drift `@forge/contracts/issue-vocabulary`
exists to prevent, one axis over: it owns *which nine buckets a status reads as*, and nothing owns
*which step a status dispatches*.

ISS-1097's `one-status-vocabulary.test.ts` deliberately does not catch these — its threshold is
twelve statuses, because a display-word map has to be total or near-total to be usable, and lowering
the number would catch these two for being the wrong vocabulary rather than for being a second copy
of the right one. The `cm:guard` above that threshold says so, and names both files.

What it would take: one derivation, from whatever declares the step a status dispatches, with the
`"Auto "` prefix applied at the error surface rather than baked into a second table.
