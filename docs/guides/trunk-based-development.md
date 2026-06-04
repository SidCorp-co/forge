# Trunk-Based Development

How `forge` branches, merges, and ships. Practical guide for contributors + maintainers; rationale in §Consequences / §Alternatives.

> Originally ADR 0014 (2026-04-26). Migrated to `docs/guides/` when `docs/decisions/` was retired.

## Context

The autonomous pipeline (`/forge-triage → /forge-plan → /forge-code → /forge-review → /forge-test → /forge-release`) creates/consumes dozens of branches per day. Long-lived branches + release-train cadence are incompatible:

- `develop` would always be ahead of dispatchable work — every issue needs rebase before code.
- Release branches couple every fix to a fortnightly cut, breaking the "open an issue, see it merged today" loop.
- The skill state machine ([status-pipeline.md](../modules/issues-pipeline/status-pipeline.md): `open → confirmed → approved → in_progress → developed → testing → … → released → closed`) already encodes the gates a release process enforces.

Merge to `main` + live deploy + E2E verification all happen at `testing` (`forge-test`), against a single live beta — not a multi-environment promotion track, so `staging → production` separation does not apply.

## Decision

**Trunk-Based Development.** Single trunk = `main`. No `develop`, no `staging`, no long-lived release branches.

### Rules

| Rule | Detail |
|---|---|
| Trunk | `main` only — always green, always deployable. |
| Feature branches | `ISS-XX-<short>` cut from `main`, lifetime < 1 day, target same-day merge. |
| Feature flags | Incomplete work merges behind `isEnabled('flagName')` from `packages/core/src/lib/feature-flags.ts` (default off). |
| Revert culture | If main breaks, revert the offending commit within 30 min. Do not push fix-forward unless revert is structurally impossible. |
| Hot-fix | Same as feature: branch from main, merge back fast. No separate hotfix track. |
| Pre-push hook | `.githooks/pre-push` runs build + tests on packages with changed files. Install via `git config core.hooksPath .githooks` (auto-set by `pnpm install` postinstall). |
| Release tagging | Tag `vX.Y.Z` on commits when ready to ship. No release branch. |

### Status pipeline (Forge)

```
open → confirmed → approved → in_progress
                                  │ /forge-code
                                  ▼
                              developed   ◄── ISS-* branch pushed, awaits review
                                  │ /forge-review  (APPROVE | reopen → /forge-fix loop)
                                  ▼
                              testing     ◄── /forge-test: merge ISS-*→main + push,
                                  │              deploy main → forge-beta (Coolify),
                                  │              full live E2E (forge-verify-live)
                                  │ PASS → auto-walk tested → pass → staging → released
                                  ▼            (FAIL on live → reopen, no revert)
                              released
                                  │ /forge-release  (append release note + delete branch)
                                  ▼
                                closed
```

Merge/deploy/live-verify run at `testing` (`/forge-test`) — the live walk must run on **merged** code. `/forge-release` is a thin release-note + close step. `tested → pass → staging` are auto-advanced by `forge-test`, not human gates.

> The old VPS staging-deploy step (`/forge-staging`) was retired 2026-05-12 — now a no-op kept only so the dispatcher doesn't error on a legacy `staging`-status job. Skill manifests live under [`packages/core/skills/<skill-name>/SKILL.md`](../../packages/core/skills/README.md).

### Branch naming — dual scheme

Repo is open source on GitHub but canonical tracker is the project's Forge instance (`ISS-<seq>` IDs from `iss_seq`). Two schemes coexist: external contributors need no Forge account, the pipeline still sees a tracker-linked branch.

#### 1. Maintainer / Forge pipeline (canonical)

```
ISS-<seq>-<slug>                 e.g. ISS-279-job-assigned-handler
ISS-<seq>-chunk-<a-z>-<slug>     e.g. ISS-293-chunk-a-issues-comments
```

Used by the Forge pipeline (`/forge-code` cuts these), maintainers, and internal contributors with a Forge account. The `ISS-<seq>` prefix ties the branch to one tracker entry and is the input the pipeline reads to advance status.

#### 2. External contributor (GitHub-native)

```
feat/<slug>                      e.g. feat/widget-api-key
fix/<slug>                       e.g. fix/race-on-shutdown
fix/gh-<num>-<slug>              e.g. fix/gh-456-token-leak
docs/<slug>      chore/<slug>      refactor/<slug>
test/<slug>      perf/<slug>
```

`gh-<num>-` is optional; use it when work is tied to a GitHub Issue. The merging maintainer assigns an `ISS-<seq>` retroactively if downstream pipeline tracking is needed.

#### Slug rules (both schemes)

- Lowercase `a-z 0-9`, kebab-case (hyphen separator, no underscores).
- 2 to ~5 words, ≤ 50 characters.
- **Total branch name** ≤ 60 characters.
- **One issue per branch.** Multi-issue branches like `ISS-261-262-rc6` are forbidden — split into separate branches.
- **No orphan ISS branches.** `ISS-attention-mvp` (no seq) is forbidden; every `ISS-` prefix needs a numeric seq from the tracker.

#### Validation

`scripts/check-branch-name.sh` enforces the rules; the pre-push hook calls it before build/test so a malformed name fails fast. Standalone:

```bash
scripts/check-branch-name.sh                          # current branch
scripts/check-branch-name.sh ISS-279-foo              # specific name
```

`SKIP_PREPUSH=1 git push` bypasses for emergency reverts only.

### Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`). Reference the issue ID (`ISS-279`) in the body, not the subject — keep subjects under 72 chars.

### Release tagging

`vX.Y.Z` tags cut directly on `main` when a slice ships. Pre-release suffix `-beta` reserved for dogfood before the next minor (e.g. `v0.1.5-beta`). No release branch, merge-back, or cherry-pick.

### Deployment & live verification

No separate staging environment or VPS deploy step. After review, `forge-test` (at `status=testing`) merges the ISS-* branch to `main`, deploys `main` to the live beta (Coolify), and runs the full Playwright E2E (`forge-verify-live`) before close. A live failure sends the issue back to `reopen` (fix-forward, no revert); `forge-release` then writes the release note and closes. Self-hosters configure their own deploy target per [release.md](release.md).

## Consequences

**Pros**

- Pipeline dispatches + merges issues continuously, no release calendar.
- Every contributor (human or skill) sees the same `main`-is-truth model — no "which branch did this ship in?" archaeology.
- Feature flags absorb half-done work, so a slow contributor doesn't block fast ones.
- Reverts are cheap — blast radius is one revert, not a cherry-pick storm.

**Cons**

- Requires CI + pre-push hook discipline; a green `main` is a contract.
- Long-running migrations must be split (schema first, code second, drop second) so a flag can toggle without locking trunk.
- Pre-push hook can fail on pre-existing flaky tests. `SKIP_PREPUSH=1` is acceptable for unrelated work — track the flake under a follow-up issue, reference it in the commit so the maintainer can re-enable the gate.

**Alternatives considered**

- **GitFlow** — rejected. `develop` becomes a perpetual rebase target for an hourly-shipping pipeline; release-branch model assumes train cadence the project lacks.
- **GitLab Flow** — closer fit, but long-lived `staging`/environment branches add merge overhead the single-trunk + live-verify-at-`testing` flow doesn't need; one beta deployed straight from `main` covers pre-release verification.
- **No branches, commit straight to main** — rejected on safety. Pre-push hook + branch + same-day merge buys a cheap review gate without slowing throughput.

## Follow-ups

- Pre-push flake cleanup tracked under a separate ISS — see project tracker.
- If multi-tenant deploys land in v0.2, this ADR may need a "promotion track" addendum (tag → environment lifecycle). Trunk model unchanged.
