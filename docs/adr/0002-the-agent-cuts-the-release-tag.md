# 0002 — The agent cuts the release tag; no code path does

**Status:** accepted · **Date:** 2026-09-27 · **Supersedes:** none · **Amended by:** [0005](0005-a-project-may-number-releases-as-prereleases.md), which answers its last consequence

## Context

This project already holds that a deploy is never a side effect of code: *"A run does not merge and
does not deploy. Both are the dispatcher's."* That rule was adopted after a `deployOnLanding`
subscriber was built to fire deploys from a status transition — a change that announced nothing,
because the deploy route returned `200` and the live commit moved.

Tagging a release is the same shape of act, and the same question was open: whether to build a code
path that cuts the tag, or to keep it in the dispatcher's hands.

## Decision

**No code path cuts a Forge release tag, and no issue is filed asking for one.** The dispatcher cuts
it, as it already fires the deploy.

The order:

1. The release allocates its number (ADR 0001).
2. The deployment is dispatched.
3. The running process is read until it reports the commit it is serving.
4. **Then** the tag is cut on that commit.

A release that reaches step 4 and cannot cut its tag is reported as unfinished, not as released.

## Consequences

- A tag never names a build that was not served. Cutting at promotion time, before identity is
  confirmed, would allow exactly that.
- Two things are deliberately **not** covered, because allocating a number is state while tagging is
  an act: `packages/core/src/release-batch/version-store.ts` remains the only allocator of `release_version`, and
  `.github/workflows/runner-autorelease.yml` keeps cutting `runner-v*` on its own clock for the runner alone.
- The dispatcher takes the number from the allocator rather than inventing one, so uniqueness and
  the burn rule of ADR 0001 keep holding.
- `/version` currently answers `pkg.version` from `packages/core/package.json` — a constant that is
  never bumped — so the running deployment cannot report the number it was given. Closing that is a
  code change and is not decided here.
