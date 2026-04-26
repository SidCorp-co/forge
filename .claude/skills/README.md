# Project-local Forge skills (jarvis-agents — TBD)

These overrides are checked in to the repo. They take precedence over the user-level / wrapper-level `forge-*` skills when working inside `jarvis-agents/`. They encode the **Trunk-Based Development** flow this project uses.

**Why they exist:** until EPIC 6 (ISS-278) ships per-project skill config from Forge UI, project quirks live as committed `SKILL.md` files.

## TBD flow (summary)

```
ISS-XX (cut from main, lifetime < 1 day, behind feature flag if incomplete)
   ↓ /forge-code  → push ISS-* → status: developed
   ↓ /forge-review → status: developed (pass) | reopen (fail → /forge-fix loop)
   ↓ /forge-release → merge ISS-* → main, push main → status: closed
```

No `staging` branch, no `staging` Forge status, no Coolify, no production branch. Production deploy = enable feature flag in production env (separate from git operations).

## Skill roles

| Skill | Role | Override |
|---|---|---|
| `forge-code/SKILL.md` | Implement + push ISS-* branch | TBD: end at `developed`, no merge main, gate new features behind flag |
| `forge-fix/SKILL.md` | Apply review/QA fix on existing ISS-* branch | TBD: same as code, prefer worktree reuse |
| `forge-release/SKILL.md` | Merge ISS-* → main, set `closed` | TBD: this is the only "release" — no production branch |
| `forge-staging/SKILL.md` | Hard no-op (no staging branch in TBD) | Refuses + comments |
| `forge-test/SKILL.md` | Hard no-op (no preview URL) | Refuses + comments |

Skills NOT overridden (wrapper skills work fine):
- `forge-triage`, `forge-clarify`, `forge-plan`, `forge-review` — read-only or API-only

## Project quirks encoded in overrides

1. **Remote name `github`** not `origin` — use `git remote | head -1` to detect dynamically
2. **No Coolify** — never call `forge_coolify_deploy`. Project is local-only deploy.
3. **pnpm monorepo** with packages: `forge/core`, `forge/web`, `forge/dev`, `forge/widget`, `forge/contracts`. Build commands run from each affected package.
4. **Worktree mode default** — parallel ISS-* sessions are common (v1 epics ISS-270..278). Default to `.claude/worktrees/iss-XX-...` unless main is provably idle.
5. **Pre-existing test failures** in `db/schema.test.ts` (`is_ceo`) + 2 flaky route mocks — don't block fixes on these.
6. **Drizzle migration numbering** — parallel branches collide on next sequence; check `ls forge/core/drizzle/migrations/*.sql | sort | tail -5` before picking a number.
7. **Feature flags** — code merging to main behind incomplete features must be gated via `forge/core/src/lib/feature-flags.ts`. v1 epic flags: `chatProvider`, `runnerFramework`, `pipelineControl`, `commentMentions`, `userPreferences`, `knowledgeOps`, `webhookAdapter`. Set flags via env: `FEATURE_<NAME>=true`.
8. **30-min revert window** — if main breaks, revert > fix-forward.

## Pre-push hook

`.githooks/pre-push` runs build + tests on packages whose files changed in the push range. Install hook with:

```bash
git config core.hooksPath .githooks
```

`pnpm install` postinstall sets this automatically.

## Status pipeline (Forge)

Used: `open → confirmed → approved → in_progress → developed → closed` plus `reopen` for review fail.

Skipped: `staging`, `released`, `tested`, `pass`, `deploying`, `testing`. If pipeline auto-routes an issue to one of these, the skill no-op + leaves status alone — human or override moves it back.

## When to update

- Project structure changes (new package, monorepo reorg)
- Test discipline / flaky test list changes
- After EPIC 6 (ISS-278) ships → migrate these to Forge UI per-project config; keep filesystem versions as fallback
- Feature flag list changes (sync `feature-flags.ts` and the README)

## How resolution works

Claude Code skill resolution prefers nearer-cwd `.claude/skills/<name>/`:

```
~/.claude/skills/forge-code/SKILL.md                                ← user level (lowest priority)
/home/kieutrung/tools/forge/.claude/skills/forge-code/SKILL.md      ← wrapper level
/home/kieutrung/tools/forge/jarvis-agents/.claude/skills/forge-code/SKILL.md   ← project level (highest)
```

When `cwd` is inside `jarvis-agents`, the project-level file wins.
