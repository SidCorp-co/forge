---
name: forge-fix
description: "Fix rejected Forge issues based on review or QA feedback. Use this skill when an issue has been reopened with rejection comments — reads the feedback, applies a scoped fix, builds, re-tests, and pushes. Triggers on: /forge-fix, fixing rejected issues, addressing review feedback, fixing QA failures, resolving reopen comments, fixing CI build failures. Also use when the pipeline needs to move an issue from reopen back to deploying."
user_invocable: true
arguments: "documentId"
---

# Forge Fix

Applies scoped fixes based on review or QA rejection feedback. This is NOT a full reimplementation — it reads what failed, fixes only that, and re-submits.

The key discipline: **fix what the feedback says, nothing more.** Expanding scope during a fix cycle leads to new bugs and infinite review loops.

## Usage

```
/forge-fix <documentId>
```

## Tools

- **forge_issues** — get issue data, update status
- **forge_comments** — read rejection feedback, post fix summary
- **forge_coolify_deploy** — trigger deployment after push
- **Codebase tools** — Read, Edit, Write, Glob, Grep, Bash

Read `references/fix-workflow.md` for parsing rejection formats, branch handling, and fix strategy details.

## Workflow

### Step 1: Fetch Issue & Feedback

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
```

Verify status is `reopen`. Find the latest rejection comment — either:
- **Code Review** (starts with `## Code Review`) — from forge-review, has severity table
- **QA Test Report** (starts with `**QA Test Report**`) — from forge-test, has pass/fail table

If feedback is unclear or missing → post clarifying comment, set `needs_info`, stop.

### Step 2: Understand the Feedback

Parse the rejection:
- **From review:** extract Bug and Minor severity findings. Ignore Low items.
- **From QA:** extract FAIL test cases and failure descriptions.

Each finding = one fix task. Don't invent additional fixes.

### Step 3: Confirm Branch & Check Out

First confirm current git state — in pipeline-resumed sessions the working tree may be on an unexpected branch:

```bash
git branch --show-current
git status
```

If dirty, stash or clean before switching. Then check out the ISS-* branch. The feature branch is always kept alive through the pipeline (forge-release merges it to production at the end):

```bash
git checkout ISS-XX-*
git pull origin ISS-XX-*
```

If not found locally, fetch and check out:
```bash
git fetch origin
git branch --list 'ISS-*' | grep <issue-number>
git checkout ISS-XX-short-title
```

### Step 4: Apply Scoped Fixes

For each finding:
1. Read the affected file at the mentioned line
2. Fix the specific issue
3. Move to the next finding

**Do not:** refactor adjacent code, add new features, "improve" things the review didn't mention, or change the overall approach. The plan was already approved — the fix should stay within its boundaries.

### Step 5: Test

If the fix touches API endpoints: run real API tests (curl affected endpoints, verify responses). Frontend-only fixes: build is sufficient — QA handles frontend testing.

### Step 6: Commit & Push

```bash
git add <specific files>
git commit -m "fix: address review feedback — <summary>"
git push
```

Separate fix commit — don't amend or squash into the original.

Push the ISS-* branch.

**Deploy mode detection:** Call `forge_config → get` and `forge_coolify_deploy → list`. If `previewDeploy` is null/missing AND Coolify list is empty → **local-only mode**. Otherwise → **deploy mode**.

**Local-only mode** (no Coolify, no preview URL):
```bash
git push origin ISS-XX-short-title
```
No baseBranch merge. No Coolify deploy. Stop here for push.

**Deploy mode — Simple / Medium** (staging deploys from baseBranch):
```bash
git push origin ISS-XX-short-title
git checkout <baseBranch> && git merge ISS-XX-short-title && git push origin <baseBranch>
git checkout ISS-XX-short-title
```

**Deploy mode — Complex** (per-issue preview from ISS-* branch):
```bash
git push origin ISS-XX-short-title
```

### Step 7: Deploy

**Local-only mode** — skip this step entirely. No environment to deploy to.

**Deploy mode** — trigger Coolify deployment after push so the environment is updated before the pipeline advances:

```
forge_coolify_deploy → deploy → { issueId: <current issue documentId> }
```

If no Coolify resources are configured within deploy mode, skip.

### Step 8: Post Comment & Set Status

**Status update must be the LAST action.** It triggers downstream pipeline steps, so all work (push, deploy, comment) must complete first.

```
forge_comments → create → {
  data: {
    body: "**Fix** — <what was fixed>\n\nAddressed N findings from <review/QA>.",
    issue: "<documentId>",
    author: "Blastoise"
  }
}
```

Set status based on deploy mode + complexity:

**Local-only mode** — always set `developed` (all complexities). Human reviews at `developed` and moves to `closed` (or `reopen`) manually. No `deploying`/`testing`/`staging`/`released` transitions.

**Deploy mode:**
- **Simple / Medium:** `deploying` (lifecycle auto-skips to `testing`, no per-issue preview)
- **Complex:** `developed` (triggers review step again for re-verification, then preview deploy)

## Fix-specific output reminder

Don't restate the review/CI feedback you parsed — just fix. (See pipeline preamble for general output rules.)