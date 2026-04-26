---
name: forge-fix
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Applies scoped fixes from review/QA feedback, ends at `developed`. forge-release merges to main after re-review pass."
user_invocable: true
arguments: "documentId"
---

# Forge Fix — jarvis-agents (TBD)

Project-local override. Applies scoped fixes; same TBD discipline as forge-code.

## Project-specific defaults

### Git remote
`git remote | head -1` — never hardcode `origin`.

### Deploy mode — TBD
- No Coolify, no auto-deploy
- Push ISS-* branch only
- End at status `developed`
- `forge-release` (separate skill) merges to main after re-review pass

### Worktree mode (preferred)

If `forge-code` created a worktree at `.claude/worktrees/iss-XX-short-title/`, **reuse it**:

```bash
# Check if worktree exists for this issue:
git worktree list | grep iss-XX-short-title

# Exists → cd into it:
cd .claude/worktrees/iss-XX-short-title

# Doesn't exist → create:
REMOTE=$(git remote | head -1)
git fetch "$REMOTE"
git worktree add .claude/worktrees/iss-XX-short-title ISS-XX-short-title
cd .claude/worktrees/iss-XX-short-title
git pull "$REMOTE" ISS-XX-short-title
```

### Build / test
Same per-package table as forge-code. Pre-existing flakies same as forge-code; don't block fixes on them.

## Workflow

1. Fetch issue + comments. Verify status = `reopen`.
2. Find latest rejection comment (Code Review or QA Test Report). If unclear → set `needs_info`, post comment, stop.
3. Parse findings (Bug + Minor only; ignore Low).
4. Switch to ISS-* branch / worktree (see above).
5. Apply scoped fixes — one finding at a time, no scope creep.
6. Build + test on affected package(s).
7. Commit `fix: address review feedback — <summary>` (separate commit, no amend).
8. Push:
   ```bash
   git push "$(git remote | head -1)" ISS-XX-short-title
   ```
   No merge to main. No Coolify.
9. Post comment summarizing what was fixed.
10. Set status `developed` (LAST). Re-review will pick it up.

## Output rules

Same as wrapper. Zero narration, fix-only, one-line status.
