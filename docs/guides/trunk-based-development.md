# Trunk-Based Development

How `forge` branches, merges, and ships — for **human contributors and maintainers**. The autonomous pipeline has its own rules ([status-pipeline.md](../modules/issues-pipeline/status-pipeline.md) + `forge-*` skill manifests) and is not covered here.

> Originally ADR 0014 (2026-04-26); rationale lives in git history.

## Model

Single trunk = `main` — always green, always deployable. No `develop`, no `staging`, no release branches.

| Rule | Detail |
|---|---|
| Branches | Short-lived, cut from `main`, target same-day merge |
| Incomplete work | Merge behind a feature flag — `isEnabled('flag')`, `packages/core/src/lib/feature-flags.ts`, default off |
| Broken `main` | Revert within 30 min; fix-forward only when revert is structurally impossible |
| Hot-fix | Same as any branch — no separate track |
| Releases | Tag `vX.Y.Z` on `main`; `-beta` suffix for dogfood builds. No release branches, no cherry-picks |

## Who ships how

| You are | Flow |
|---|---|
| External contributor | `feat/<slug>`-style branch → PR → maintainer review → merge |
| Maintainer | Commit to `main` directly (or a short-lived branch you merge yourself) → push → deploy. No issue or review gate required |
| Autonomous pipeline | `ISS-<seq>-<slug>` branch with review/test gates — see pipeline docs |

## Branch naming

Enforced by `scripts/check-branch-name.sh` (called by the pre-push hook; run standalone to check a name).

```
feat/<slug>     fix/<slug>      fix/gh-<num>-<slug>
docs/<slug>     chore/<slug>    refactor/<slug>
test/<slug>     perf/<slug>
```

- Slug: kebab-case lowercase `a-z 0-9`, ≤ 50 chars; total name ≤ 60.
- `ISS-<seq>-<slug>` is reserved for tracker-linked work (pipeline + maintainers with a Forge account). One issue per branch; numeric seq required.
- `main` is exempt.

## Pre-push hook

`.githooks/pre-push` validates the branch name and builds the packages with changed files before every push. Installed via `git config core.hooksPath .githooks` (auto-set by `pnpm install`).

- `SKIP_PREPUSH=1 git push` — bypass (emergency, or pre-existing flaky tests on unrelated work; file a follow-up for the flake)
- `PREPUSH_FULL=1 git push` — also run the affected packages' test suites

## Commits

Conventional Commits (`feat:` `fix:` `docs:` `refactor:` `test:` `chore:` `perf:`). Subject ≤ 72 chars; issue IDs (`ISS-279`) in the body, not the subject.

## Deploy

One live beta deployed from `main` (Coolify). Maintainers deploy directly after pushing; pipeline-tracked issues deploy + E2E-verify at the `testing` stage. Self-hosters: see [release.md](release.md).
