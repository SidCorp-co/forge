# Worktree mode (default ON) — forge-code / forge-fix

This repo runs many parallel ISS-* sessions (v1 epics dispatch 5+ children simultaneously). **Default to worktree mode** unless main is provably idle.

## Detection

Either signal triggers worktree mode:

```bash
git status -s            # any output = main is dirty
git worktree list        # >1 line = parallel session active
```

If neither: branch mode is fine (work directly on a feature branch in the main checkout).

## Create

```bash
REMOTE=$(git remote | head -1)
git fetch "$REMOTE" "$BASE"
git worktree add .claude/worktrees/iss-XX-short-title -b ISS-XX-short-title "$BASE"
cd .claude/worktrees/iss-XX-short-title
```

All subsequent commands (install, build, test, commit, push) run inside the worktree.

## Reuse (forge-fix scenario)

If `forge-code` already created a worktree at `.claude/worktrees/iss-XX-short-title/`, **reuse it** instead of creating a new one:

```bash
if git worktree list | grep -q iss-XX-short-title; then
  cd .claude/worktrees/iss-XX-short-title
  REMOTE=$(git remote | head -1)
  git fetch "$REMOTE"
  git pull "$REMOTE" ISS-XX-short-title    # in case forge-code pushed after worktree creation
else
  REMOTE=$(git remote | head -1)
  git fetch "$REMOTE"
  git worktree add .claude/worktrees/iss-XX-short-title ISS-XX-short-title
  cd .claude/worktrees/iss-XX-short-title
fi
```

## Cleanup

`forge-release` removes the worktree after merge (see `forge-release/SKILL.md` Step 6). Do NOT clean up from `forge-code` or `forge-fix` — review may need to inspect, and forge-test may re-use.

## Why worktrees and not branches

A worktree is a separate working directory tied to the same `.git` directory. Multiple worktrees can have different branches checked out simultaneously, so:

- `forge-code` for ISS-42 can run in `.claude/worktrees/iss-42-foo/` while `forge-test` for ISS-41 runs in the main checkout.
- No `git stash` / `git checkout` thrashing between sessions.
- `git status` in each worktree shows only its own changes.

The downside: each worktree consumes disk (~repo size of working files). For this repo (~500MB), that's negligible.

## Migration sequence collision

Drizzle migrations are numbered (`0001_foo.sql`, `0002_bar.sql`, ...). Parallel ISS branches will collide on the next sequence. Before picking a number:

```bash
ls forge/core/drizzle/migrations/*.sql | sort | tail -5
```

Pick a number higher than any in-flight branch (check all worktrees + open PRs). If conflict happens at merge time, renumber the lower one — that's `forge-fix`'s job.
