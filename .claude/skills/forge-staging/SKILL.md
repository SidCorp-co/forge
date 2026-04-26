---
name: forge-staging
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Runs `pnpm deploy:staging` after release merge to push main → VPS staging, verifies /health, sets status `staging`. Auto-triggered by forge-release."
user_invocable: true
arguments: "documentId"
---

# Forge Staging — jarvis-agents (TBD deploy)

In TBD, "staging" = **deploy `main` to the staging VPS** so QA can validate before flipping the feature flag in any production environment. This is NOT a git branch operation — there is no `staging` branch. It runs the `deploy-staging.sh` script which SSH's to the VPS and rebuilds the docker compose stack.

Auto-triggered by `forge-release` immediately after the merge-to-main + push completes. Can also be invoked manually for re-deploy.

## Preconditions

- Issue status = `released` (set by `forge-release`)
- Latest main commit on origin matches the merge commit from `forge-release`
- SSH access to `root@165.22.96.128` (or `STAGING_VPS_HOST` env override) is available on the runner
- `scripts/deploy-staging.sh` exists in the repo (added when TBD setup landed)

If status is not `released`, abort with comment "Cannot deploy — issue is at <status>, must be `released` first."

## Workflow

1. Fetch issue. Verify `status === 'released'`.
2. Run the deploy script from repo root:
   ```bash
   pnpm deploy:staging
   ```
   This:
   - SSH's to VPS
   - `git fetch + reset --hard origin/main` on the VPS clone
   - `docker compose build core web`
   - `docker compose up -d --force-recreate core web`
   - Waits 5s
   - `curl -s https://stg-jarvis-a2.thejunix.com/health` — expects `{"ok":true,...}`
3. **On script success:**
   - Post comment:
     ```
     **Deployed to staging** — `<commit-hash>` is live at https://stg-jarvis-a2.thejunix.com
     `/health` reports OK. Feature flag `<flagName>` (if applicable) is still off until enabled in env.
     QA the change at the staging URL, then close the issue manually when satisfied.
     ```
   - Set status `staging` (LAST action).
4. **On script failure (non-zero exit):**
   - Post comment with the script's last 30 lines of output and the diagnostic command:
     ```
     **Staging deploy FAILED** — script exit non-zero. Inspect logs:
       ssh root@165.22.96.128 'cd /opt/jarvis-stg-a2 && docker compose -f docker-compose.prod.yml -p jarvis-stg-a2 logs --tail=50 core web'
     Status reverted to `released` for manual retry.
     ```
   - **Do NOT** revert the merge to main — main commit stays. Only the deploy is broken.
   - Status stays at `released` (no advance to `staging`). Human runs `pnpm deploy:staging` manually after fixing infra.

## Env overrides (for testing or alt environments)

```
STAGING_VPS_HOST=root@165.22.96.128
STAGING_VPS_PATH=/opt/jarvis-stg-a2
STAGING_PROJECT=jarvis-stg-a2
STAGING_HEALTH_URL=https://stg-jarvis-a2.thejunix.com/health
STAGING_COMPOSE_FILE=docker-compose.prod.yml
```

## What this skill does NOT do

- ❌ Run database migrations (the docker container does on startup if configured)
- ❌ Enable feature flags in env (separate step — operator edits `.env` on VPS, then restarts container)
- ❌ Rollback on failure (no auto-rollback in v0.1 — human investigates)
- ❌ Deploy to production (no production exists yet in v0.1)
- ❌ Tag the commit (tagging is batched separately at version cuts)

## Tools

- `forge_issues`, `forge_comments`
- Bash (for `pnpm deploy:staging`)
- Read

## Output rules

One-line status updates from the script (it prints `[deploy-stg HH:MM:SS]` prefix). Final summary in the issue comment.
