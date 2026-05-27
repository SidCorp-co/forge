---
name: forge-release
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Fires at status=released after forge-test has verified the branch locally. Merges ISS-* to the resolved target branch, appends the issue's CHANGELOG entry, pushes, cleans up the worktree, and auto-closes the issue. VPS staging deploy is deprecated."
user_invocable: true
arguments: "documentId"
---

# Forge Release — jarvis-agents (TBD merge + auto-close)

Final step of the auto-chain. By the time this skill fires the branch has already been verified locally by `forge-test`. This skill merges to the resolved target branch, folds the issue's `releaseNotes` bullet into `CHANGELOG.md` `## [Unreleased]`, pushes, and closes the issue.

Replaces the previous flow that auto-chained into `forge-staging` for a VPS deploy. VPS staging is deprecated.

## CHANGELOG flow

Two-stage CHANGELOG pipeline:

1. **Per-issue close (this skill):** read the issue's typed `releaseNotes` field (drafted by `forge-clarify`) and append a bullet under `## [Unreleased]` in `CHANGELOG.md`. Issues with `section: 'Skip'` or `releaseNotes: null` contribute nothing.
2. **Periodic release cut (`/forge-cut-release X.Y.Z`):** maintainer-triggered. Promotes accumulated `[Unreleased]` block to `[X.Y.Z] - YYYY-MM-DD`, bumps every package + Tauri file in lockstep, tags, pushes. Triggers the GH Actions build.

This skill never bumps versions or tags. It only buffers entries in `[Unreleased]`.

## Status flow

```
developed  →  forge-review (halt, post comment, no advance)
              [human transitions to testing]
testing    →  forge-test (boot local, E2E, auto-advance: testing → pass → staging → released)
released   →  forge-release (THIS skill: merge + push + close)
closed
```

## Preconditions

- Status = `released` (set by the auto-chain in `forge-test`)
- Latest `forge-test` comment reports PASS or soft-pass (`e2e-not-verified` is acceptable)
- Branch `ISS-XX-short-title` exists on the remote at the verified SHA

If status is not `released`, abort with comment `forge-release invoked at status=<status>; expected released` and do nothing.

## Workflow

### 0. Resolve target branch

```ts
const cfg = await forge_config({ action: 'get', projectId, issueId: documentId });
const TARGET = cfg.config.branchConfig.targetBranch;
if (!TARGET) {
  throw new Error('forge-release: project has no targetBranch configured. Aborting to avoid merging to the wrong trunk.');
}
```

`forge_config` returns `null` when the project's `base_branch` / target is unset. **Never default to `'main'`** — abort and ask the admin to configure `projects.base_branch` first. Use `$TARGET` throughout.

### 1. Fetch issue + verdict check

`forge_issues → get` + `forge_comments → list` (last 5). Verify latest `forge-test` comment reports PASS or soft-pass. If FAIL is the most recent verdict, abort, leave at `released`, post comment ([references/comment-formats.md](references/comment-formats.md) → "On forge-test fail verdict").

### 2. Detect remote + workspace mode

```bash
REMOTE=$(git remote | head -1)
```

Prefer the **target-branch worktree** (`$TARGET`, usually `main`). If the `$TARGET` worktree is dirty (`git status -s` non-empty), abort + comment "On busy target worktree".

### 3. Pull target + merge

```bash
git checkout "$TARGET"
git pull "$REMOTE" "$TARGET"
git fetch "$REMOTE" ISS-XX-short-title
git merge --no-ff "$REMOTE/ISS-XX-short-title" -m "Merge ISS-XX: <one-line summary>"
```

`--no-ff` preserves the issue's commit history. Squash is opt-in only.

**On conflict:** `git merge --abort`, transition `released → reopen`, post conflict comment ([references/comment-formats.md](references/comment-formats.md) → "On merge conflict"), stop.

### 4. Re-run scoped tests on the merge commit

```bash
CHANGED=$(git diff --name-only HEAD~1)
for PKG in $(echo "$CHANGED" | awk -F/ '/^packages\//{print $2}' | sort -u); do
  (cd "packages/$PKG" && npx vitest run 2>&1 | tail -20) || FAIL=1
done
```

Final sanity check that the merge didn't break anything (race: another release landed in between). On **new** failures: `git reset --hard HEAD~1`, transition `released → reopen`, post comment ("On post-merge test failure"), stop.

### 4.5. Append CHANGELOG entry

Driver: [`scripts/append-changelog.sh`](scripts/append-changelog.sh). Full flow + recovery: [`references/changelog-append.md`](references/changelog-append.md).

```bash
NOTES=$(forge_issues get --documentId "$DOCID" | jq -r .releaseNotes)
if [[ "$NOTES" != "null" ]]; then
  SECTION=$(jq -r .section <<<"$NOTES")
  if [[ "$SECTION" != "Skip" ]]; then
    USER_FACING=$(jq -r .userFacing <<<"$NOTES")
    TECHNICAL=$(jq -r '.technical // ""' <<<"$NOTES")
    bash .claude/skills/forge-release/scripts/append-changelog.sh \
      CHANGELOG.md "$SECTION" "$USER_FACING" "$TECHNICAL"
    if ! git diff --quiet CHANGELOG.md; then
      git add CHANGELOG.md
      git commit --amend --no-edit       # fold into the merge commit
    fi
  fi
fi
```

If the script exits non-zero (malformed section, style violation), abort BEFORE the push. Do NOT push a partial release. Comment routes back to `forge-clarify` to redraft.

### 5. Push target

```bash
git push "$REMOTE" "$TARGET"
```

If rejected: see [references/comment-formats.md](references/comment-formats.md) → "On push rejection after merge" — one rebase retry, then escalate.

### 6. Cleanup

```bash
git push "$REMOTE" --delete ISS-XX-short-title 2>&1 | tail -2
git worktree list | awk '/iss-xx-short-title/ {print $1}' | xargs -r -n1 git worktree remove --force
git branch -D ISS-XX-short-title 2>/dev/null
git branch -D ISS-XX-short-title-test 2>/dev/null
```

### 7. Post completion comment + close

Comment: see [references/comment-formats.md](references/comment-formats.md) → "On successful merge + close".

Then transition `released → closed` as the LAST action:

```
forge_issues → transition released → closed
```

## What this skill does NOT do

- ❌ Auto-chain into `forge-staging` — deprecated.
- ❌ Squash by default — uses `--no-ff` to preserve ISS-* history.
- ❌ Production deploy — no prod env in v0.1.
- ❌ Tag the commit — version tagging is batched via `forge-cut-release`.
- ❌ Roll back automatically — every failure path either preserves the merge or transitions to `reopen`.

## Failure modes

| Failure | Action | Status after |
|---|---|---|
| Latest forge-test verdict is FAIL | Abort + comment | `released` |
| Target-branch worktree dirty | Abort + comment | `released` |
| Merge conflict | `git merge --abort`, comment | `reopen` |
| Post-merge tests fail (new) | `git reset --hard HEAD~1`, comment | `reopen` |
| Malformed `releaseNotes` (bad section / ISS-NNN) | Abort BEFORE push, route to forge-clarify | `released` |
| Push rejected (race) | Rebase + retry once; second fail → abort | `released` |

## References

- [scripts/append-changelog.sh](scripts/append-changelog.sh) — Step 4.5 driver. Typed args, style guard, auto-creates subsection if missing.
- [references/changelog-append.md](references/changelog-append.md) — full Step 4.5 flow, `releaseNotes` shape, amend strategy, recovery.
- [references/comment-formats.md](references/comment-formats.md) — all comment templates (completion, conflict, fail, busy, push rejection).
- [../README.md § English-only rule](../README.md) — comments must be in English.
