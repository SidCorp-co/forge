---
name: forge-staging
description: "Merge feature branch to baseBranch for staging deployment. Triggered when an issue reaches pass status — merges the ISS-* branch to the project's baseBranch and sets status to staging. Triggers on: /forge-staging, merging to staging, promoting to staging, deploying to staging. Also use when the pipeline needs to move an issue from pass to staging."
user_invocable: true
arguments: "documentId"
---

# Forge Staging

Merges the ISS-* feature branch to the project's baseBranch (staging) after QA passes. This is a git-only step — no code changes, just branch merging.

## Usage

```
/forge-staging <documentId>
```

## Tools

- **forge_issues** — get issue data, update status
- **forge_comments** — post staging comment
- **forge_config** — get project config (baseBranch)
- **forge_coolify_deploy** — trigger staging deployment
- **Codebase tools** — Bash (git commands)

## Workflow

### Step 0: Local-only mode guard

Call `forge_config → get` and `forge_coolify_deploy → list`. If `previewDeploy` is null/missing AND Coolify list is empty, this project is in **local-only mode** — staging is not applicable.

Post a comment and exit without changing status:

```
forge_comments → create → {
  data: {
    body: "**Staging skipped** — project is in local-only mode (no Coolify, no preview URL). In this mode the pipeline ends at `developed` for human review and `closed` manually. Skip forge-staging.",
    issue: "<documentId>",
    author: "Pidgeot"
  }
}
```

Stop. Do NOT call `forge_issues → update`.

### Step 1: Fetch Issue & Project Config

```
forge_issues → get → { documentId: "<id>" }
forge_config → get → {}
```

Read: `baseBranch` from project config (default: `main`).

Verify status is `pass`. If not, stop.

### Step 2: Set In-Progress

```
forge_issues → update → { documentId: "<id>", data: { status: "in_progress" } }
```

### Step 3: Find Feature Branch

```bash
git fetch origin
git branch -r | grep -i "ISS-<issue-id>"
```

The feature branch follows the pattern `ISS-XX-short-title`.

### Step 4: Merge to baseBranch

```bash
git checkout <baseBranch>
git pull origin <baseBranch>
git merge origin/ISS-XX-short-title --no-ff -m "Merge ISS-XX to <baseBranch> for staging"
git push origin <baseBranch>
```

If merge conflicts occur, stop and post a comment describing the conflicts. Set status to `on_hold`.

### Step 5: Deploy to Staging

Trigger Coolify deployment after the merge so the staging environment is updated before the pipeline advances:

```
forge_coolify_deploy → deploy → {}
```

If no Coolify resources are configured, skip — deployment may be handled by external CI.

### Step 6: Post Comment & Set Status

**Status update must be the LAST action.** It triggers downstream pipeline steps, so all work (merge, deploy, comment) must complete first.

```
forge_comments → create → {
  data: {
    body: "**Staging** — Merged ISS-<id> to <baseBranch>. Coolify deploy triggered.",
    issue: "<documentId>",
    author: "Pidgeot"
  }
}
```

```
forge_issues → update → { documentId: "<id>", data: { status: "staging" } }
```

(General output rules — see pipeline preamble.)