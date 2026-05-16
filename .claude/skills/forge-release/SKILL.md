---
name: forge-release
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents (TBD). Fires at status=released after forge-test has verified the branch locally. Merges ISS-* to main, pushes, cleans up the worktree, and auto-closes the issue. VPS staging deploy is deprecated."
user_invocable: true
arguments: "documentId"
---

# Forge Release — jarvis-agents (TBD merge + auto-close)

Final step of the auto-chain. By the time this skill fires the branch has already been verified locally by `forge-test` (servers booted, acceptanceCriteria walked via Playwright). This skill performs the merge to `main`, pushes, and closes the issue.

Replaces the previous flow that auto-chained into `forge-staging` for a VPS deploy. VPS staging is deprecated.

## Status flow

```
developed  →  forge-review (halt, post comment, no advance)
             [human reads comment, transitions to testing]
testing    →  forge-test (boot local, E2E, auto-advance: testing → pass → staging → released)
released   →  forge-release (THIS skill: merge + push + close)
closed
```

## Preconditions

- Status = `released` (set by the auto-chain in `forge-test`)
- Latest `forge-test` comment on the issue reports PASS or soft-pass (`e2e-not-verified` is acceptable — caller already accepted the soft-gate trade-off)
- Branch `ISS-XX-short-title` exists on the remote and is up to date relative to the verified SHA

If status is not `released`, abort with comment `forge-release invoked at status=<status>; expected released` and do nothing.

## Workflow

### 0. Resolve target branch

Load the resolved branch config first so every git command below merges into the right branch:

```ts
const cfg = await forge_config({
  action: 'get',
  projectId: '<projectId>',
  issueId: '<documentId>',
});
const TARGET = cfg.config.branchConfig.targetBranch;   // what we merge INTO
```

Fallback if `branchConfig` is absent: `cfg.config.baseBranch ?? 'main'`. The rest of this skill uses `$TARGET` exclusively.

### 1. Fetch issue + last comments

`forge_issues → get` + `forge_comments → list` (last 5).
Verify the latest `forge-test` comment exists and reports PASS or soft-pass. If a fail comment is the most recent test verdict, abort with `Cannot release — last forge-test verdict was FAIL. Run forge-fix first.` and leave status at `released` for a human to inspect.

### 2. Detect remote + workspace mode

```bash
REMOTE=$(git remote | head -1)
```

Prefer the **target-branch worktree** (`$TARGET`, usually `main`) for the merge. If the `$TARGET` worktree is dirty (`git status -s` non-empty), abort with `Target-branch worktree busy — cannot release. Wait for the in-flight session to finish, then re-trigger /forge-release <documentId>.` and leave the run at `released`.

### 3. Pull target + merge

```bash
git checkout "$TARGET"
git pull "$REMOTE" "$TARGET"
git fetch "$REMOTE" ISS-XX-short-title
git merge --no-ff "$REMOTE/ISS-XX-short-title" -m "Merge ISS-XX: <one-line summary from issue title>"
```

`--no-ff` preserves the issue's commit history under a merge commit for easy auditing. Squash is opt-in only — never default to it here.

**On conflict**:
- `git merge --abort`
- Transition status `released → reopen` (allowed transition; see state-machine memory).
- Post comment with the conflict files and a `forge-fix` prompt:
  ```
  **Release merge conflict** — `<TARGET>` moved between forge-test and forge-release.
  Conflicting files:
    - <list>
  Run /forge-fix <documentId> to rebase ISS-XX-short-title onto `<TARGET>` and re-trigger forge-test.
  ```
- Stop. Do NOT close.

### 4. Re-run scoped tests on the merge commit

```bash
CHANGED=$(git diff --name-only HEAD~1)
# Map paths to packages, then run vitest per affected package:
for PKG in $(echo "$CHANGED" | awk -F/ '/^packages\//{print $2}' | sort -u); do
  (cd "packages/$PKG" && npx vitest run 2>&1 | tail -20) || FAIL=1
done
```

This is a final sanity check that the merge didn't break anything (race conditions: another release landed between forge-test and now). On **new** failures (i.e. that weren't already failing before the merge):
- `git reset --hard HEAD~1` to undo the merge.
- Transition status `released → reopen`.
- Post comment with the failing tests + the diagnostic.
- Stop.

### 5. Push target

```bash
git push "$REMOTE" "$TARGET"
```

If the push is rejected (someone else released first): `git pull --rebase "$REMOTE" "$TARGET" && git push "$REMOTE" "$TARGET"`. If rebase produces conflicts, treat like step 3's conflict handler.

### 6. Cleanup

Delete the remote branch + any worktree for this issue:

```bash
git push "$REMOTE" --delete ISS-XX-short-title 2>&1 | tail -2
git worktree list | awk '/iss-xx-short-title/ {print $1}' | xargs -r -n1 git worktree remove --force
git branch -D ISS-XX-short-title 2>/dev/null
git branch -D ISS-XX-short-title-test 2>/dev/null
```

### 7. Post completion comment

```markdown
## Released — ISS-XX

Merged to `<TARGET>` as `<merge-hash>`.
Branch + worktree cleaned up.

Local E2E verdict (forge-test): PASS (or soft-pass with `e2e-not-verified`)

🤖 Generated by forge-release (TBD merge + auto-close)
```

### 8. Walk status to closed

`released → closed` is allowed by the state machine. Set status `closed` as the LAST action.

```
forge_issues → transition released → closed
```

## What this skill does NOT do

- ❌ Auto-chain into `forge-staging` — that skill is deprecated (VPS deploy removed).
- ❌ Squash by default — uses `--no-ff` to preserve ISS-* history. Squash is manual-only via `git merge --squash`.
- ❌ Production deploy — no prod env in v0.1.
- ❌ Tag the commit — version tagging is batched separately.
- ❌ Roll back automatically on any failure — every failure path either preserves the merge or transitions to `reopen` for a human-or-`forge-fix` decision.

## Failure modes & recovery

| Failure | Action | Status after |
|---|---|---|
| Latest forge-test verdict is FAIL | Abort, comment | `released` (human inspects) |
| Target-branch worktree dirty | Abort, comment to wait | `released` |
| Merge conflict | `git merge --abort`, comment | `reopen` |
| Post-merge tests fail (new) | `git reset --hard HEAD~1`, comment | `reopen` |
| Push rejected (race) | Rebase + retry once; second fail → abort | `released` (human pushes) |

## Tools

- `forge_issues` (get + transition — final `released → closed`)
- `forge_comments` (list + create)
- `Read`, `Bash` (merge, push, cleanup)

## Output rules

Terse. Status updates only. Final summary in the merge comment.
