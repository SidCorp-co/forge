---
name: forge-release
description: "Merge approved issue code to production branch and trigger deployment. Use this skill when an issue has been approved at staging and needs to be released — squash-merges the ISS-* feature branch to the production branch, triggers Coolify deploy, and closes the issue. Triggers on: /forge-release, releasing an issue, merging to production, deploying to production. Also use when the pipeline needs to move an issue from released to closed."
user_invocable: true
arguments: "documentId"
---

# Forge Release

The final step in the issue pipeline: `released → closed`. Squash-merges the ISS-* feature branch to the production branch and triggers deployment. This is a lightweight skill — no codebase exploration, no review. Just merge, deploy, clean up.

The ISS-* branch is the single source of truth for the issue's changes. It has been kept alive through the entire pipeline (coding, fixes, reviews). baseBranch (staging) may have commits from other issues mixed in — we never merge baseBranch to production. We merge ISS-* directly.

## Usage

```
/forge-release <documentId>
```

## Tools

- **forge_issues** — get issue data, update status
- **forge_comments** — post release comment
- **forge_config** — get baseBranch, productionBranch, Coolify config
- **forge_coolify_deploy** — trigger production deploy (if configured)
- **Bash** — git merge, push, branch cleanup

## Workflow

### Step 0: Local-only mode guard

Call `forge_config → get` and `forge_coolify_deploy → list`. If `previewDeploy` is null/missing AND Coolify list is empty → project is in **local-only mode**.

In local-only mode, `forge-release` is not applicable — there is no production branch auto-promotion. The pipeline ends at `developed` (human review) and moves to `closed` manually. Post a comment and exit without changing status:

```
forge_comments → create → {
  data: {
    body: "**Release skipped** — project is in local-only mode (no Coolify, no preview URL). In this mode the pipeline ends at `developed` for human review; the human closes the issue manually when satisfied. Skip forge-release.",
    issue: "<documentId>",
    author: "Charizard"
  }
}
```

Stop. Do NOT call `forge_issues → update`, do NOT merge branches.

### Step 1: Fetch Issue & Config

```
forge_issues → get → { documentId: "<id>" }
forge_config → get → {}
```

Verify status is `released`. Read `productionBranch` from config (fallback: `master`). Read `baseBranch` from config (fallback: `main`).

### Step 2: Confirm Git State

```bash
git branch --show-current
git status
```

If dirty, stash before proceeding.

### Step 3: Check for Sibling Issues

If the issue has `relations` with type `related_to`, check if any sibling shares the same ISS-* branch (from batched execution). Fetch each related issue:

```
forge_issues → get → { documentId: "<related docId>" }
```

- If a sibling is on the same branch but NOT at `released` → **stop**. Post comment: "Cannot merge — ISS-XX on same branch is still at `<status>`. Release both together or wait."
- If all siblings on the branch are at `released` → proceed, will close all of them at the end.

### Step 4: Find the ISS-* Branch

```bash
git fetch origin
git branch -r --list 'origin/ISS-*' | grep <issue-number>
```

If no ISS-* branch found (Simple+staging issues that merged directly to baseBranch during forge-code):
- Code is already on baseBranch. Check if baseBranch ≠ productionBranch.
- If different: merge baseBranch to productionBranch (but this may pull in other issues' commits — see Step 5 audit).
- If same: code is already on production. Skip merge, just deploy.

### Step 5: Diff Audit

Before merging, compare what will land on production:

```bash
git checkout <productionBranch> && git pull origin <productionBranch>
git diff <productionBranch>...origin/ISS-XX-short-title --stat
```

Check the changed files against the issue's `plan` field (affected files list). If there are unexpected files not mentioned in the plan:
- Post a warning comment listing the unexpected files
- Still proceed (the code passed review + QA), but flag it for visibility

### Step 6: Squash Merge to Production

```bash
git checkout <productionBranch>
git pull origin <productionBranch>
git merge --squash origin/ISS-XX-short-title
git commit -m "ISS-XX: <issue title>"
git push origin <productionBranch>
```

Squash merge creates one clean atomic commit per issue on the production branch. All intermediate commits (implementation + fixes + review cycles) are collapsed.

If merge conflict → post comment with conflict details, set `reopen`, stop.

### Step 7: Deploy (if Coolify configured)

Check if the project has Coolify resources:

```
forge_coolify_deploy → list → {}
```

If resources exist:
```
forge_coolify_deploy → deploy → {}
```

If no Coolify: skip — CI/CD may auto-deploy from production branch, or deployment is manual.

### Step 8: Clean Up Feature Branch

```bash
git push origin --delete ISS-XX-short-title
```

### Step 9: Post Comment & Close

```
forge_comments → create → {
  data: {
    body: "**Released** — Merged to <productionBranch>. <deploy status>.",
    issue: "<documentId>",
    author: "Dragonite"
  }
}
```

Close the issue (and any sibling issues on the same branch):

```
forge_issues → update → { documentId: "<id>", data: { status: "closed" } }
```

## Output Rules (Save Tokens)

- **Zero narration.** Just execute the steps.
- **One-line status only.** "Merged ISS-42 to master, deploy triggered. Closed." — nothing more.
