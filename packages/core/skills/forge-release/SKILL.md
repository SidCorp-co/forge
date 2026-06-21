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

### Step 0.5: Decompose-aware guard (epic child vs parent)

If the issue has `metadata.branchConfig` or `metadata.useIntegrationBranch`, it is part of a decomposed epic — **only the parent reaches production/base**. **Read `.claude/skills/forge-plan/references/decompose-execution.md` and follow the forge-release section.** In short: a **child** already landed on the integration branch, so skip the merge steps — just CHANGELOG (if present), optionally delete its own `ISS-*` branch, comment, and close. The **parent** (`useIntegrationBranch`) is the single promotion point: substitute the integration branch (`metadata.integrationBranch`) for the `ISS-*` branch in the merge steps (`git fetch` + retry if a child looks missing), deploy, CHANGELOG, **delete the integration branch** in Step 8, then in Step 9 close the parent AND cascade-close any still-open children. For a non-decompose issue (no such metadata), ignore this step.

### Step 1: Fetch Issue & Config

```
forge_issues → get → { documentId: "<id>" }
forge_config → get → {}
```

Verify status is `released`. Read `productionBranch` and `baseBranch` from config; never default to a literal branch — if either is null, ABORT and surface the missing config.

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

### Step 4: Is a merge even needed? (single-branch / already-merged guard — do this FIRST)

**Re-merging a branch that is already on the production branch produces an empty commit that fails, so the release never completes and the stage re-dispatches forever. Guard against it before touching git.**

```bash
git fetch origin
```

**SKIP the merge (Steps 5–6) and go straight to Step 7 when EITHER holds:**
- **Single-branch project — `productionBranch == baseBranch`** (e.g. both `main`). forge-code already merged the ISS-* branch into the base/production branch during the code stage to deploy it for testing, so the code is **already on production**. There is nothing left to merge.
- **Already an ancestor of production** — the branch is already merged:
  ```bash
  git merge-base --is-ancestor origin/ISS-XX-short-title origin/<productionBranch> && echo ALREADY_MERGED
  ```
  If it prints `ALREADY_MERGED` (exit 0), skip the merge.

Otherwise (a real two-branch gitflow where the code is NOT yet on production) → continue to Step 5 + Step 6.

If there is no ISS-* branch AND the code is not on production → nothing to release: post a comment and set `reopen`, stop.

### Step 5: Diff Audit (only when a merge is needed)

Before merging, compare what will land on production:

```bash
git checkout <productionBranch> && git pull origin <productionBranch>
git diff <productionBranch>...origin/ISS-XX-short-title --stat
```

Check the changed files against the issue's `plan` field (affected files list). If there are unexpected files not mentioned in the plan:
- Post a warning comment listing the unexpected files
- Still proceed (the code passed review + QA), but flag it for visibility

### Step 6: Squash Merge to Production (only when a merge is needed)

Skip this entirely if Step 4 said the code is already on production.

```bash
git checkout <productionBranch>
git pull origin <productionBranch>
git merge --squash origin/ISS-XX-short-title
git commit -m "ISS-XX: <issue title>"
git push origin <productionBranch>
```

Squash merge creates one clean atomic commit per issue on the production branch. All intermediate commits (implementation + fixes + review cycles) are collapsed.

If merge conflict → post comment with conflict details, set `reopen`, stop. If `git commit` reports **nothing to commit**, the branch was already merged — do NOT loop: treat it as already-on-production and continue to Step 7.

### Step 7: Deploy (if Coolify configured)

Check if the project has Coolify resources:

```
forge_coolify_deploy → list → {}
```

If resources exist:
```
forge_coolify_deploy → deploy → { issueId: <current issue documentId> }
```

If no Coolify: skip — CI/CD may auto-deploy from production branch, or deployment is manual.

### Step 7.5: Draft & append the CHANGELOG entry

Release notes are written **here**, not at clarify — by now the change is fully implemented, so the user-facing summary reflects what actually shipped instead of a pre-implementation guess. If `releaseNotes` is already populated on the issue (a human or earlier step pre-filled it), use it as-is; otherwise draft it now from the issue + the merged diff. Shape:

```typescript
{ section: 'Added'|'Changed'|'Fixed'|'Removed'|'Security'|'Skip', userFacing: string, technical?: string|null }
```

**Pick the section** — map the change to the right [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) bucket:

| Section | When to pick |
|---|---|
| `Added` | a new user-perceivable feature/screen/command/endpoint/capability |
| `Changed` | existing behavior changes visibly (UI, defaults, semantics) |
| `Fixed` | a user-hittable bug is resolved |
| `Removed` | a capability went away |
| `Security` | a vulnerability is patched (phrase neutrally, not like a CVE advisory) |
| `Skip` | internal-only (refactor, infra, test harness) — no `CHANGELOG.md` entry |

**Draft the two strings:**
- **userFacing** — 1–2 plain sentences a non-developer understands; lead with the verb ("Added X", "Fixed Y", "You can now Z"); no file/function/ticket names; ≤500 chars.
- **technical** *(optional)* — one terse maintainer breadcrumb (root cause / surface area); ≤500 chars.

**Persist it back to the typed field** (so the issue records what shipped) before appending — do NOT also write a release-notes block into `description`:

```
forge_issues → update → { documentId: "<id>", data: { releaseNotes: { section, userFacing, technical? } } }
```

Then decide:
- `section === 'Skip'` → done, no `CHANGELOG.md` entry (internal-only change).
- Otherwise → format a bullet and insert it under `### <section>` inside `## [Unreleased]` in `CHANGELOG.md`:

```
- **<userFacing>**
  *Technical: <technical>*    ← only emit this second line when `technical` is non-empty
```

Use `awk`/`sed` to find the `## [Unreleased]` heading, the matching `### <section>` sub-heading (creating it if absent), and insert the bullet at the top of that sub-list so the most recent entry sits first. Commit the CHANGELOG bump as **its own commit** on the production branch and push it:
```bash
git commit -m "docs(changelog): ISS-XX <topic>" && git push origin <productionBranch>
```
Always a separate commit — the Step 6 merge (when there was one) is already pushed, and you must **never amend/force-push** a shared production branch to fold it in.

Style: present-tense, one short sentence, no trailing period after the bold (`**…**`) text is fine. Don't include `ISS-XX` IDs or PR references — those live in git history.

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

(General output rules — see pipeline preamble.)
