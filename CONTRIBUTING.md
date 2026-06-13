# Contributing to forge

Thanks for your interest. The project is in alpha — every piece of feedback is valuable.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing issues before opening a new one.
- For large features: open a **discussion** or a `proposal` issue before writing code.
- Skim the [Trunk-Based Development guide](docs/guides/trunk-based-development.md). The branching model is non-standard for a reason; the rules below are derived from it.

## Branching model — Trunk-Based Development

Single trunk = `main`. **No `develop`, no `staging`, no long-lived release branches.** Feature work merges to main as fast as it can compile + pass tests.

| Rule | Detail |
|---|---|
| Trunk | `main` only — always green, always deployable |
| Feature branches | Two schemes (see below). Cut from `main`, lifetime < 1 day, target same-day merge |
| Feature flags | Incomplete work merges behind `isEnabled('flagName')` (default off, env-controlled) |
| Hot-fix | Same as feature: branch from main, merge back fast. No separate hotfix track. |
| Revert culture | If `main` breaks, revert within 30 min. Don't push fix-forward unless revert is structurally impossible. |
| Pre-push hook | `.githooks/pre-push` — cheap guards only (warns on branch naming, hard-fails the tauri `bundle.active` guard). Builds/tests are opt-in: `PREPUSH_BUILD=1` / `PREPUSH_FULL=1`. Install via `git config core.hooksPath .githooks` (auto-set by `pnpm install` postinstall). |
| Release tagging | Tag `vX.Y.Z` on commits when ready to ship. No release branch. |

### Branch naming — pick one scheme

**External contributors (recommended)** — GitHub-native, no Forge account required:

| Form | Example |
|---|---|
| `feat/<slug>` | `feat/widget-api-key` |
| `fix/<slug>` | `fix/race-on-shutdown` |
| `fix/gh-<num>-<slug>` | `fix/gh-456-token-leak` (links a GitHub Issue) |
| `docs/<slug>` `chore/<slug>` `refactor/<slug>` `test/<slug>` `perf/<slug>` | `docs/branch-naming` |

**Maintainers / Forge pipeline (canonical)** — the autonomous skill pipeline uses these; ties the branch to a tracker entry:

| Form | Example |
|---|---|
| `ISS-<seq>-<slug>` | `ISS-279-job-assigned-handler` |
| `ISS-<seq>-chunk-<a-z>-<slug>` | `ISS-293-chunk-a-issues-comments` |

**Slug rules**:
- Lowercase `a-z 0-9`, kebab-case (hyphens, no underscores).
- ≤ 5 words, ≤ 50 chars. Total branch ≤ 60 chars.
- **One issue per branch.** No multi-issue (`ISS-261-262-…`) — split into separate branches.

The pre-push hook warns on violations (`scripts/check-branch-name.sh`); maintainers may ask you to rename before merge. Check a name ad-hoc:

```bash
scripts/check-branch-name.sh                  # validates the current branch
scripts/check-branch-name.sh feat/my-thing    # validates a name
```

Full model: [Trunk-Based Development guide](docs/guides/trunk-based-development.md).

## Contribution workflow

1. Fork the repo and create a branch from `main`. Pick a name from the
   [Branch naming](#branch-naming--pick-one-scheme) table above.
2. Write code + tests. For local pre-flight, `PREPUSH_BUILD=1 git push` builds
   the packages you touched (`PREPUSH_FULL=1` also runs their test suites).
   The hook is convenience, **not** the gate — CI is.
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add X` — new feature
   - `fix: Y` — bug fix
   - `docs: Z` — docs only
   - `refactor:`, `test:`, `chore:`, `perf:`
   - Reference issue ID in the body (`ISS-279`), not the subject — keeps subjects under 72 chars.
4. Open a PR and fill out the template. CI runs automatically; the **`ci-passed`**
   check is the single required gate (it aggregates install + language + the
   affected packages' build/test + markdown-link integrity) and must be green
   before merge. Same-day merge is the target; if it stretches past a day, gate
   the work behind a feature flag and merge anyway.
5. A maintainer reviews within 3 business days. Reverts are cheap — don't fight them.

## Coding standards

- Lint + format must pass in CI.
- Test coverage should not regress.
- Breaking changes: document them in the PR description and update CHANGELOG.
- Long-running migrations: split into schema-first + code-second + drop-third so a feature flag can toggle without locking the trunk.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). At minimum:

- Version in use
- Steps to reproduce
- Expected vs. actual behavior

## Proposing features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the **problem** first, not the solution — maintainers may suggest a better approach.

## Security

**Do not open public issues** for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By submitting code, you agree to contribute under [Apache-2.0](LICENSE).
