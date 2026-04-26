---
name: forge-release
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Merges ISS-* branch to main and closes the issue — the TBD `release` is the merge to trunk. No Coolify, no production branch."
user_invocable: true
arguments: "documentId"
---

# Forge Release — jarvis-agents (TBD)

In TBD, "release" = **merge feature branch to trunk (main)**. Production deploy is decoupled (driven by env enabling the feature flag, not by a branch). This skill performs that merge and closes the issue.

## Preconditions

The issue must satisfy:
- Status = `developed`
- Latest review comment from `Lapras` (forge-review) reports 0 bugs / minors at must-fix level (or only deferred Lows). If review was rejected, this skill must NOT run — `forge-fix` handles that loop.
- `git fetch && git log "$(git remote | head -1)/ISS-XX-short-title"` shows the branch exists on the remote.

If preconditions fail → post comment explaining what's blocking, do NOT change status, exit.

## Workflow

1. Fetch issue. Verify `status === 'developed'`.
2. Verify last review-comment is a pass:
   ```
   forge_comments → list → { filters: { issue: "<id>" }, limit: 5 }
   ```
   Look for the most recent comment from `Lapras` (or any code-review agent). If it lists Bug-severity findings, abort with comment "Cannot release — open Bug findings remain. Run /forge-fix first."
3. Detect mode:
   - **Branch mode**: in main worktree, work directly there
   - **Worktree mode**: if `.claude/worktrees/iss-XX-short-title/` exists, use it for the merge; or temporarily switch the main worktree to `main` (the worktree branch was pushed already — we just need main checked out somewhere)
4. Pull latest main:
   ```bash
   REMOTE=$(git remote | head -1)
   git checkout main
   git pull "$REMOTE" main
   ```
5. Merge ISS-* (no-ff to preserve issue history):
   ```bash
   git merge --no-ff ISS-XX-short-title -m "Merge ISS-XX: <one-line summary>"
   ```
   - If conflicts: abort, post comment with conflict file list, set status `reopen`, stop.
6. Run tests on affected packages one more time after merge:
   - From `git diff --name-only HEAD~1` find packages → run `pnpm test` per package.
   - If any new failures → revert merge (`git reset --hard HEAD~1`), post comment, set status `reopen`, stop. **No fix-forward.**
7. Push:
   ```bash
   git push "$REMOTE" main
   ```
8. (Optional) tag if part of a release set: not done per-issue in TBD; do separately at version cut.
9. Clean up worktree (if used): `git worktree remove .claude/worktrees/iss-XX-short-title --force` (branch already merged).
10. Post completion comment:
    ```
    **Released to trunk** — Merged ISS-XX into main as commit <hash>.
    Feature flag: `<flagName>` (off by default — enable via FEATURE_<NAME>=true in
    target env). No Coolify deploy in this project — deployment happens separately.
    ```
11. Set status `closed` (LAST action).

## Failure modes

- **Conflict on merge** → revert, status `reopen`, comment with conflict list. Human or `forge-fix` rebases.
- **Test failure post-merge** → revert merge (`reset --hard`), status `reopen`, comment with failing test names.
- **Network failure on push** → main local is ahead of remote; retry push or instruct human to push manually.

## What this skill does NOT do

- ❌ Trigger Coolify deploy (project doesn't use it)
- ❌ Merge to a production branch (none exists — main is production trunk)
- ❌ Create a release tag (tagging is a separate, batched action)
- ❌ Enable feature flags (flags are env-controlled per environment, not by code)
- ❌ Squash-merge by default (uses `--no-ff` for clear issue history; squash is opt-in via `git merge --squash` when invoked manually)

## Tools

- `forge_issues`, `forge_comments`
- Read, Bash (no Edit/Write — pure git operations)

## Output rules

One-line status updates only. Final summary in the close comment.
