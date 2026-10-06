# 0010 — A release number is spent when it leaves Forge, not when a batch opens

**Status:** accepted · **Date:** 2026-10-06 · **Supersedes:** the burn rule of [0001](0001-a-release-version-is-a-counter.md) and "failed ones included" in [0005](0005-a-project-may-number-releases-as-prereleases.md)

## Context

[0001](0001-a-release-version-is-a-counter.md) made a failed release burn its number, so that no two
artefacts ever wore one version. It counted a number as used the moment a release batch cut it. On
dev, ISS-234 showed the cost of that reading: two batches aborted before any push, because the box
had no GitHub credential, and burned `0.4.0-dev.35` and `0.4.0-dev.36`. Neither number named
anything outside Forge's own table, and the sweep then re-cut the same roster every two minutes,
spending a number each time. The gap was not identity protection; it was numbers nobody would ever
see.

semantic-release, changesets and release-please all derive the next version from the last one
published and keep no allocator at all. A number that was never published cannot collide with
anything.

## Decision

**A cut number is spent when it may exist outside Forge**, and only then. The allocator,
`packages/core/src/release-batch/version-store.ts:highestSpentVersion`, counts a release row's
number when the run shipped, is still in flight, recorded a promotion or a finish, or its abort
said it pushed its tag. A batch that ended with none of those hands its number back, and the next
batch wears it. The ended row keeps `release_version` as the number it tried, so the history still
shows the attempt.

- **What 0001 protects still holds.** A number that left Forge, as a tag, a promotion or a served
  build, is never worn twice: every one of those conditions keeps it spent.
- **The allocator stays the only writer**, on the same per-project advisory lock. The partial
  unique index `pipeline_runs_release_version_uq` narrows to rows still holding their number
  (migration `0417`) and stays the backstop; it cannot read a promotion or a pushed tag, so the
  allocator, not the index, is the rule.
- **A prerelease line continues from the highest spent number**, not the highest cut, so 0005's
  `N` skips no number that never shipped.

## Consequences

- A gap in the sequence now means a release that left Forge and then failed, never a batch that
  aborted inside it.
- Two rows can carry the same `release_version`: one ended and unshipped, one that wore the number
  afterwards. The version history shows the newest run per version
  (`packages/core/src/release-batch/versions.ts`).
- An abort that pushed its tag must say so (`tagged`), or its number is handed back while the tag
  exists. That is the one input this rule trusts the release run to report.
