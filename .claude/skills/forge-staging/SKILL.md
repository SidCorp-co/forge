---
name: forge-staging
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents — TBD project, no staging branch. Skill is a hard refusal."
user_invocable: false
---

# Forge Staging — jarvis-agents (no-op, TBD)

This project uses **Trunk-Based Development** — there is no `staging` branch and no per-issue staging promotion. "Staging" is an environment that runs `main` with feature flags configured per-env, not a git branch.

## Workflow

If invoked:

1. Fetch the issue (sanity check).
2. Post comment via `forge_comments → create`:
   ```
   **Staging skipped** — jarvis-agents uses Trunk-Based Development.
   There is no staging branch in this repo. To deploy to staging, configure
   the staging environment with the relevant `FEATURE_*=true` env flags and
   point staging at `main`. See <repo>/CLAUDE.md § "Branching strategy".
   ```
3. Do NOT change status. Do NOT merge anything. Do NOT call `forge_coolify_deploy`.

That's it. This skill should not normally be invoked in this project — Forge pipeline auto-progression should not move issues to `staging` status here.
