# 0005 — A project may number its releases as prereleases of the next version

**Status:** accepted · **Date:** 2026-10-04 · **Supersedes:** [0001](0001-a-release-version-is-a-counter.md) in part, for a project that declares a line; the last consequence of [0002](0002-the-agent-cuts-the-release-tag.md)

## Context

Forge's own dev branch ships ahead of `main`, on its own tracker, many times a day. Under 0001 its
first release would be `0.1.0` while the product it ships already reads `0.3.0`, and nothing it
deployed reported a version at all: `/version` answered a `package.json` constant nobody bumped
(0002's last consequence). The owner asked that dev releases carry versions too (2026-10-04).

## Decision

- **A project document may declare `release.prerelease: { of, label }`.** Every release cut on that
  project is then `<of>-<label>.<N>` — `0.4.0-dev.1`, `0.4.0-dev.2` — instead of raising MINOR.
  `N` continues from the highest cut on that same line, failed ones included, so 0001's burn holds.
- **The number is still allocated, never chosen** (`packages/core/src/release-batch/version-store.ts`),
  and ordered by semver precedence: a prerelease sorts below the release it previews.
- **A line declared below what the project already cut is refused** (`RELEASE_VERSION_LINE_BEHIND`),
  never skipped forward. Raising `of` once that release has shipped is the operator's act.
- **A prerelease is never re-cut**; the next number replaces a failed one.
- **The dev release's commit bumps the product version** to the allocated number
  (`scripts/cut-release.sh X.Y.Z-dev.N`, on `dev`), so `/version` and the sidebar report it, and its
  tag is `dev-vX.Y.Z-dev.N`, cut only once that commit is served (0002), outside `main`'s `v*`.

## Consequences

- A project that declares no line keeps 0001 exactly.
- Between two releases, a deploy that is not a release keeps reporting the last release's number
  beside its own `sourceCommit`: the number says which release a build contains, the commit says
  which build it is.
