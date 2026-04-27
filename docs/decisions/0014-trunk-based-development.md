# ADR 0014 — Trunk-Based Development

- **Status:** Accepted
- **Date:** 2026-04-26
- **Supersedes:** the implicit GitFlow assumption in earlier `CONTRIBUTING.md`

## Context

`jarvis-agents` ships an autonomous pipeline (Forge skills run `/forge-plan → /forge-code → /forge-review → /forge-release` end-to-end). Branches are created and consumed by the pipeline itself, not just by humans, on the order of dozens per day. Long-lived branches and a release-train cadence are incompatible with that throughput:

- `develop` would always be ahead of what the pipeline can dispatch — every issue would need rebase before code phase.
- Release branches would couple every fix to a fortnightly cut, breaking the "open an issue, see it merged today" loop the pipeline targets.
- The skill state machine (`open → confirmed → approved → in_progress → developed → released → staging → closed`) already encodes the gates a release process traditionally enforces.

The team also runs deploys directly to a single staging VPS, not a multi-environment promotion track, so a Coolify-style `staging → production` separation does not apply.

## Decision

Adopt **Trunk-Based Development**. Single trunk = `main`. No `develop`, no `staging`, no long-lived release branches.

### Rules

| Rule | Detail |
|---|---|
| Trunk | `main` only — always green, always deployable. |
| Feature branches | `ISS-XX-<short>` cut from `main`, lifetime < 1 day, target same-day merge. |
| Feature flags | Incomplete work merges behind `isEnabled('flagName')` from `forge/core/src/lib/feature-flags.ts` (default off). |
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
                                  │ /forge-review
                                  ▼
                              developed (pass) | reopen (fail → /forge-fix loop)
                                  │ /forge-release
                                  ▼
                              released    ◄── merged to main, push complete
                                  │ /forge-staging (auto-chained from release)
                                  ▼
                              staging     ◄── deployed to VPS, /health OK
                                  │ (human verifies on staging URL)
                                  ▼
                                closed
```

**Skipped statuses** (used by other projects with a full Coolify pipeline): `tested`, `pass`, `deploying`, `testing`. The skill overrides under `.claude/skills/` enforce this — see `.claude/skills/README.md`.

### Branch naming

- **Pipeline-driven** (most branches): `ISS-<seq>-<short-kebab>`. The `ISS-<seq>` prefix matches the issue's `iss_seq` so a glance at the branch tells you which issue it implements. Example: `ISS-279-job-assigned-handler`.
- **Hot-fix without an issue**: `fix/<short-kebab>`, file the matching issue retroactively.
- **Pure docs / chore**: `chore/<short-kebab>` is fine; tests still run via the pre-push hook.

`feat/xyz` from earlier `CONTRIBUTING.md` is **deprecated** — use `ISS-<seq>-<short>` so the branch ties back to the tracker.

### Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`). Reference the issue ID in the body, not the subject (`ISS-279`), to keep subjects under 72 chars.

### Release tagging

`vX.Y.Z` tags are cut directly on `main` when a slice of work is ready to ship. Pre-release suffix `-beta` is reserved for the dogfood phase before the next minor (e.g. `v0.1.5-beta`). No release branch, no merge-back, no cherry-pick gymnastics.

### Staging deployment

```bash
pnpm deploy:staging   # SSH to VPS, git fetch + reset main, docker rebuild, verify /health
```

Target VPS (configurable via `STAGING_*` env vars, defaults below):

- Host `root@165.22.96.128` — path `/opt/jarvis-stg-a2`
- Compose `docker-compose.prod.yml` project `jarvis-stg-a2`
- URL `https://stg-jarvis-a2.thejunix.com`

`forge-release` chains into `forge-staging` automatically after merging to main. On deploy failure, status stays at `released` for manual retry.

## Consequences

### Pros

- The autonomous pipeline can dispatch + merge issues continuously without coordinating with a release calendar.
- Every contributor — human or skill — sees the same `main`-is-truth model. No "which branch did this ship in?" archaeology.
- Feature flags absorb half-done work, so a slow contributor doesn't block fast contributors.
- Reverts are cheap. The blast radius of a bad commit is one revert, not one cherry-pick storm across release branches.

### Cons

- Requires CI + pre-push hook discipline. A green `main` is a contract; it costs vigilance to keep.
- Long-running migrations need to be split (schema first, code second, drop second) so a feature flag can toggle without locking the trunk.
- The pre-push hook can fail on pre-existing flaky tests (currently `db/schema.test.ts is_ceo`, `tests/integration/comment-mentions.test.ts`, plus 2 route-mock flakes). `SKIP_PREPUSH=1` is acceptable for unrelated work — track the flake under a follow-up issue (see [docs/quickstart.md §Testing](../quickstart.md#testing)).

### Alternatives considered

- **GitFlow** — rejected. The `develop` branch becomes a perpetual rebase target for a skill pipeline that ships issues hourly. The release branch model assumes train cadence the project does not have.
- **GitLab Flow** — closer fit, but the `staging` long-lived branch duplicates what `forge-staging` already covers via deploy script, with worse merge ergonomics.
- **No branches, commit straight to main** — rejected on safety grounds. Pre-push hook + branch + same-day merge buys an inexpensive review gate without slowing throughput.

## Follow-ups

- Pre-push flake cleanup tracked under a separate ISS — see project tracker for the live list.
- If multi-tenant deploys land in v0.2, this ADR may need a "promotion track" addendum (a tag → environment lifecycle). It does not need to change the trunk model.
