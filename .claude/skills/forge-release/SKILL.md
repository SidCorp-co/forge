---
name: forge-release
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Merges ISS-* branch to main and auto-triggers forge-staging deploy. Status flow: developed → released (merged) → staging (deployed) → human closes."
user_invocable: true
arguments: "documentId"
---

# Forge Release — jarvis-agents (TBD release + auto-deploy)

In TBD this skill performs **the merge to trunk**, then chains into `forge-staging` to push the change to the VPS. Status progression:

```
developed  → /forge-release →  released  → /forge-staging (auto) →  staging  → human → closed
```

The two-phase split (`released` after merge, `staging` after deploy) gives a recovery point: if the deploy script fails, `released` is the safe state — main is updated, but staging didn't get the change. Human runs `pnpm deploy:staging` manually after fixing infra.

## Preconditions

- Status = `developed`
- Latest review-comment from `Lapras` (or any code-review agent) reports a pass — no Bug-severity findings outstanding. If review was rejected, **abort** with comment `Cannot release — open Bug findings remain. Run /forge-fix first.` Do NOT change status.
- `git fetch && git log "$(git remote | head -1)/ISS-XX-short-title"` shows the branch on the remote.

## Workflow

1. Fetch issue + last 5 comments. Verify status `developed` and last review is a pass.
2. Detect remote name (`git remote | head -1`).
3. Workspace setup:
   - Branch mode: in main worktree, `git checkout main && git pull <remote> main`
   - Worktree mode: switch to a worktree where `main` can be checked out. If main is busy, ask: do the merge from inside the ISS-* worktree by `git fetch <remote> main:main` — this updates the local `main` ref without checking it out, then `git push <remote> ISS-XX-...:main` (server-side fast-forward — only works if main is exactly at the merge-base; otherwise needs an actual merge worktree).

   Practical default: switch to the **main worktree** for the merge. If it's dirty, abort with comment `Main worktree busy — cannot release. Wait for the in-flight session to finish.`
4. Merge:
   ```bash
   git merge --no-ff ISS-XX-short-title -m "Merge ISS-XX: <one-line summary>"
   ```
   On conflict: `git merge --abort`, set status `reopen`, post comment with conflict files, stop. **Do not fix-forward conflicts here** — that's `forge-fix`'s job.
5. Re-run tests on packages whose files changed (`git diff --name-only HEAD~1` → map to `forge/<pkg>/`):
   ```bash
   pnpm --filter "@forge/<pkg>" test
   ```
   On any new failure: `git reset --hard HEAD~1`, set status `reopen`, post comment with failures. Stop.
6. Push main:
   ```bash
   git push <remote> main
   ```
7. Clean up worktree (if exists for this issue): `git worktree remove .claude/worktrees/iss-XX-* --force`.
8. Post completion comment for the merge step:
   ```
   **Merged to trunk** — ISS-XX merged into main as <hash>.
   Triggering staging deploy next.
   ```
9. Set status `released` (LAST action of this skill — does NOT close the issue).
10. **Auto-chain into `forge-staging`** by calling that skill on the same documentId:
    - This runs `pnpm deploy:staging`, verifies /health, posts a deploy comment, and sets status `staging` on success
    - On deploy failure, status stays at `released` (the merge is preserved); human runs deploy manually
    - If `forge-staging` skill is unavailable in this session, just post a comment "Manual deploy needed: `pnpm deploy:staging`" and stop

After both skills complete: status is `staging`. Human verifies the change at https://stg-jarvis-a2.thejunix.com and manually sets `closed` once satisfied.

## What this skill does NOT do

- ❌ Auto-close the issue (left for human verification on staging)
- ❌ Squash by default (uses `--no-ff` to preserve issue history; squash is opt-in via `git merge --squash` if invoked manually)
- ❌ Run the deploy itself (delegates to `forge-staging` for separation of concerns)
- ❌ Production deploy (no prod env in v0.1)
- ❌ Tag the commit (tagging batched at version cuts)

## Failure modes & recovery

| Failure | Action | Status after |
|---|---|---|
| Review still has Bug findings | Abort, comment | unchanged (`developed`) |
| Merge conflict | `git merge --abort`, comment | `reopen` |
| Post-merge tests fail | `git reset --hard HEAD~1`, comment | `reopen` |
| Push rejected (race) | Pull + retry once; if still fails, abort with comment | unchanged |
| Worktree busy | Abort, comment to wait | unchanged |
| Deploy script fails (in chained forge-staging) | Main commit kept; deploy not done | `released` (manual retry) |

## Tools

- `forge_issues`, `forge_comments`, Read, Bash
- Skill chain: `forge-staging` (invoked via Skill tool)

## Output rules

One-line status during merge + tests. Final summary in the merge comment. Deploy summary handled by `forge-staging`.
