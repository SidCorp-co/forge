# 0004 — The last entry of a release chain may name the tag that ships it

**Status:** accepted · **Date:** 2026-10-13 · **Supersedes:** none

## Context

A project can declare how its code reaches production through `projects.release_chain` (ADR 0003):
`[]` ships nothing, `[{branch}]` is an act on a live deploy binding, and two or more entries cross
branches and then deploy. None of the three can say that **a version tag is what ships the
project**. epodsystem-core is such a project: code merged to `dev` reaches production only when a
`vX.Y.Z` tag containing it is cut and deployed.

With the chain empty, `packages/core/src/projects/release-chain.ts:retiredReleaseAxes` derives
`releaseModel: 'none'`, `packages/core/src/release-batch/gate.ts:resolveReleaseGate` answers `null`,
and `packages/core/src/issues/merged-at.ts:refuseUnshippedClose` accepts any `merged_at` mark. So
`developed -> closed` and `awaiting_release -> closed` passed every gate. On 2026-10-05 two runs
closed issues no tag carried (epodsystem ISS-352 and ISS-354), and on 2026-10-07 a bare
`forge advance` took ISS-380 `awaiting_release -> closed` the same way. The owner had already
written the rule into an always-injected knowledge entry; runs read it and closed anyway. That is
the affordance biting twice, which `CLAUDE.md` answers with a redesign rather than better prose.

## Decision

**The last entry of the chain may carry `tag`, a glob naming the tags that ship the project.**

```
releaseChain: [{ branch: 'dev', tag: 'v*.*.*' }]
```

The pattern is 1 to 100 characters from letters, digits, `.`, `_`, `/`, `-` and `*`; `*` matches any
run of characters and every other character matches itself
(`packages/core/src/projects/release-tag.ts:releaseTagPatternSchema`). Only the last entry may carry
one, because it is the entry that is live: a `tag` anywhere else is refused
`RELEASE_CHAIN_TAG_NOT_LAST`. The same shape is held in Postgres by
`projects_release_chain_ok` (migration `0328`), so a write around the API meets it too.

**A close on such a project is refused unless a tag matching the pattern contains the issue's
landing commit.** The rule is `packages/core/src/issues/release-tag-close.ts:holdReleaseTagClose`,
called by `packages/core/src/issues/apply-transition.ts:transitionIssueStatus` before its
transaction opens, so every surface that writes `closed` meets it: REST single, REST batch, MCP, the
release finish. It applies to every actor. The tags are read before the transaction opens, so the
transaction re-reads the landing commit under a row lock and stops as `STALE_TRANSITION` where the
mark moved to another commit meanwhile: a close is made on the landing a tag was shown to hold and
on no other. Its answers:

| reading | answer |
|---|---|
| a matching tag contains the landing commit | the close proceeds |
| none does | `CLOSE_REQUIRES_RELEASE_TAG` (422) naming the landing commit, the newest matching tag by version order, and `awaiting_release` as where the issue rests |
| the issue has no landing commit | the same code, saying so |
| the repository's tags could not be read | `RELEASE_TAG_UNREAD` (503) with the reader's reason |

An unreadable list is not an empty one, so it never reads as "no tag" and never as "tagged". The
landing commit is the one Forge observed, else the one a caller claimed (`merged_claimed_commit`):
a tag that contains a claimed commit proves it exists.

**An agent's close on such a project is not rewritten to `awaiting_release`.**
`packages/core/src/issues/release-gate-hold.ts:resolveAgentCloseTarget` returns the request
unchanged, because the rewrite answers a different question (is this release's batch pressed) and
would absorb the refusal the issue asks for. The close is refused or, once a tag contains the
landing, succeeds with nothing edited by hand.

**Two readers answer `tagsContaining`**
(`packages/core/src/projects/repository-reader.ts:RepositoryReader`), by the route the project's
repository is read through (ISS-1398): the GitHub binding lists the repository's tags and compares
the landing against each matching one, newest first, ten at a time, until one contains it or every
one has been read; the deploy key fetches every tag's commits and asks git
(`for-each-ref --contains`). A repository with more than 1,000 tags is refused by name on the GitHub
route rather than read in part.

## Consequences

- A project that declares no `tag` closes exactly as before. Setting one on a real project is a
  separate act for that project's owner; this decision authorises it for none.
- `retiredReleaseAxes` still derives `publish` or `promote` for a tagged chain, so the plugin's
  readers of those three names keep working. They do not read `tag`; the forge CLI's reading of the
  refusal is an issue in `forge-plugin`.
- The release batch is not taught to cut tags (ADR 0002 keeps that with the dispatcher). A batch
  finish on a tagged project closes only the issues a tag already contains and reports the rest
  through the existing close-failure path, and a tagged project with no live deploy binding still
  answers `RELEASE_TARGET_UNDECLARED` at the batch doors as any publish project does.
- The always-injected knowledge rule `closed-means-a-version-tag-carries-it` becomes redundant on a
  project that declares the tag, and is deleted there when it does, because the gate owns it.
- The settings screen shows no field for `tag`; it hands back the value it read so a save of other
  repository settings does not drop it.
