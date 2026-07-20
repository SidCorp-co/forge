---
name: forge-release
description: "Merge approved issue code to production branch and trigger deployment. Use this skill when an issue has been approved at staging and needs to be released — squash-merges the ISS-* feature branch to the production branch, triggers Coolify deploy, and closes the issue. Triggers on: /forge-release, releasing an issue, merging to production, deploying to production. Also use when the pipeline needs to move an issue from released to closed."
user_invocable: true
arguments: "documentId"
---

# Forge Release

The final step in the issue pipeline: `released → closed`. Lands the issue's own changes onto the production branch and triggers deployment. This is a lightweight skill — no codebase exploration, no review. Just land the diff, deploy, clean up.

The ISS-* branch holds this issue's changes. Release = get **this issue's own changes — and only those** — onto `productionBranch`, then deploy and close. The one non-obvious trap is called out in Step 6.

**State-never-lies (VISION №10):** `merged_at` and the "Released" comment are promises other issues rely on — a blocks-gate/decompose child dispatches the moment `merged_at` is stamped, trusting the base branch now has this code. Never let branch-name equality or a push exit code stand in for verified git ancestry (see Step 4 and Step 8) — a wrongly-skipped merge or a silently-failed push must halt the release, not complete it.

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

If the issue has `metadata.branchConfig` or `metadata.useIntegrationBranch`, it is part of a decomposed epic — **only the parent reaches production/base**. **Read `.claude/skills/forge-plan/references/decompose-execution.md` and follow the forge-release section.** In short: a **child** already landed on the integration branch, so skip the merge steps — just CHANGELOG (if present), optionally delete its own `ISS-*` branch, comment, and close (still subject to the Step 8 verify-land gate below — a child's own commits must show as landed on the integration branch before it deletes its branch or closes). The **parent** (`useIntegrationBranch`) is the single promotion point: substitute the integration branch (`metadata.integrationBranch`) for the `ISS-*` branch in the merge steps (`git fetch` + retry if a child looks missing) and in the Step 8 gate, deploy, CHANGELOG, **delete the integration branch** in Step 9, then in Step 10 close the parent AND cascade-close any still-open children. For a non-decompose issue (no such metadata), ignore this step.

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

### Step 4: Is a merge even needed? (single-branch / already-merged guard — verify, don't infer)

**Re-merging a branch that is already on the production branch produces an empty commit that fails, so the release never completes and the stage re-dispatches forever. Guard against it before touching git.**

```bash
git fetch origin
HEAD_SHA=$(git rev-parse origin/ISS-XX-short-title 2>/dev/null || git rev-parse ISS-XX-short-title)
```

Resolve `HEAD_SHA` once here — the ISS-* branch tip — and reuse the same value in the Step 8 verify-land gate below.

**SKIP the merge (Steps 5–6) and go straight to Step 7 ONLY when there is POSITIVE evidence the code is already on `productionBranch`:**
- **Ancestry check (primary):**
  ```bash
  git merge-base --is-ancestor $HEAD_SHA origin/<productionBranch> && echo ALREADY_MERGED
  ```
  If it prints `ALREADY_MERGED` (exit 0), skip the merge.
- **Squash-commit fallback** (ancestry is always false after a squash merge — the original commit SHA never appears verbatim in the target branch's history): `git log origin/<productionBranch> --grep 'ISS-XX' --oneline` returns the issue's squash commit, or the issue's net diff vs `baseBranch` is already fully present on `origin/<productionBranch>` (`git diff $HEAD_SHA origin/<productionBranch> -- <issue's changed files>` shows no missing hunks).

**`productionBranch == baseBranch` is NOT, by itself, evidence of an already-completed merge.** Branch-name equality only means the two config values happen to match — it says nothing about whether this issue's commits actually reached them. A project whose real workflow defers the land to the release step itself (e.g. `mergeStates.baseBranch` pointing at a late pipeline state, so nothing merges until here) has `productionBranch == baseBranch` on every single issue with nothing yet landed — inferring "already merged" from that equality alone is exactly the false-positive that let a release stamp `merged_at` and close while the code sat only on the ISS-* branch. When neither the ancestry check nor the squash-diff fallback returns positive evidence, **always** fall through to Step 5 + Step 6 and actually land it — regardless of branch names.

If there is no ISS-* branch AND the code is not on production → nothing to release: post a comment and set `reopen`, stop.

### Step 5: Diff Audit (only when a land is needed)

Sanity-check that what will land on production is just this issue's own net change (its diff against `baseBranch`) and lines up with the issue's `plan`. If unexpected files show up, flag them in a comment but proceed — the code already passed review + QA.

### Step 6: Land the issue's changes on production (only when a land is needed)

Goal: put **this issue's own changes — and only those — on `productionBranch`** as one clean squashed commit, then continue to deploy. Skip if Step 4 already found them on production.

The one non-obvious trap (it has caused real release loops): the `ISS-*` branch is cut from `baseBranch`, and `baseBranch` can sit far ahead of `productionBranch` (it accumulates every issue, released or not). So carry across **only the commits this issue added on top of `baseBranch`** — never merge the whole branch into production, which drags in other issues' unreleased work and conflicts on files this issue never touched. *How* you isolate that diff (cherry-pick the issue's commits, apply its net diff vs base, …) is your call from the live repo state.

If you can't land cleanly — the issue's files have diverged on production, or it depends on other unreleased work — do NOT force a whole-branch merge or rebase the base-derived branch onto production (that re-drags the divergence and loops). Set `reopen` with a clear note so forge-fix lands the issue's diff onto production and resolves the conflict there; if it genuinely can't be released on its own, set `waiting` for a human and say why.

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

### Step 8: Verify the land (mandatory gate — before branch delete or close)

**This is the state-never-lies gate.** Nothing between here and Step 4 re-confirmed against the remote — Steps 5–7.5 could have hit a push that silently failed, or Step 4 could have wrongly skipped the merge. Re-establish ground truth from the remote before doing anything irreversible (branch delete) or declaring success (the "Released" comment, `closed`, `merged_at`):

```bash
git fetch origin
git merge-base --is-ancestor $HEAD_SHA origin/<productionBranch> && echo LANDED
# squash fallback if the ancestry check does not print LANDED — this MUST confirm the issue's
# CODE is present, never just a commit whose message mentions the ID. Step 7.5's own
# `docs(changelog): ISS-XX <topic>` commit also matches a bare `--grep 'ISS-XX'`, so a plain
# log-grep here would report LANDED off the changelog bump alone with zero code landed —
# exactly the class of lie this gate exists to catch. Use the same diff-presence check as
# Step 4 instead, scoped to the issue's own changed files:
git diff $HEAD_SHA origin/<productionBranch> -- <issue's changed files>
# empty output (no missing hunks) = the issue's net diff is fully present = LANDED.
# If you still want the commit-message signal as a secondary corroboration, exclude the
# changelog commit explicitly: git log origin/<productionBranch> --grep 'ISS-XX' --oneline | grep -v '^.* docs(changelog):'
```

- **LANDED** (ancestry check prints `LANDED`, or the diff-presence fallback shows no missing hunks for the issue's changed files) → continue to Step 9.
- **NOT LANDED** → **HALT.** Do NOT run Step 9 (branch delete), do NOT post the Step 10 "Released" comment, do NOT close the issue, and do NOT let `merged_at` stamp. Post a comment stating the actual git state — `$HEAD_SHA` (the ISS-* branch tip) vs the current `origin/<productionBranch>` HEAD, and that the issue's diff is absent from the remote — then set status `reopen` (so forge-fix lands the diff) or `waiting` if it genuinely can't be released on its own. Stop here; do not proceed to Step 9 or Step 10.

### Step 9: Clean Up Feature Branch (only after Step 8 returns LANDED)

```bash
git push origin --delete ISS-XX-short-title
```

### Step 10: Post Comment & Close (only after Step 8 returns LANDED)

Reaching this step means Step 8 already confirmed the issue's commits are on `origin/<productionBranch>` — the comment below is true by construction, never a hopeful guess:

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

## Regression: verified-land gate (brand-gateway ISS-28 manual repro)

**Scenario that exposed the bug:** a project (brand-gateway) with `baseBranch == productionBranch == "master"` and a workflow that defers the real merge to the release step (`mergeStates.baseBranch: "released"`). ISS-28's commits (`9cacbc7`/`c90f2a7`/`b956f46`) existed only on the local `ISS-28-shell-foundation` branch; `origin/master` never received them. The old Step 4 saw `productionBranch == baseBranch`, inferred "forge-code already merged it," skipped Steps 5–6 entirely, and the run proceeded straight through deploy → CHANGELOG → branch delete → "Released — Merged to master" comment → `closed` (which auto-stamped `merged_at`). Downstream decompose children (ISS-29/30/31) would have dispatched believing the shell was on `master` when it never was.

**Verify the fix against this scenario:**
1. Reproduce the setup: an ISS-* branch with unmerged commits, `productionBranch == baseBranch`, nothing pushed to `origin/<productionBranch>` yet.
2. Run Step 4 — confirm it no longer skips the merge on branch-name equality alone; with no ancestry/squash evidence, it falls through to Step 5 + 6 and actually lands the diff.
3. If the land step is forced to fail (simulate a push that silently no-ops), confirm Step 8's gate reports NOT LANDED, and that no branch delete, no "Released" comment, no `closed` transition, and no `merged_at` stamp occur — the run halts at `reopen`/`waiting` with a comment naming the real `$HEAD_SHA` vs `origin/<productionBranch>` HEAD.
4. Confirm the legitimate already-merged short-circuit (ancestry TRUE) still skips the merge in Step 4 and still reaches `closed` via Step 8 → 9 → 10 without a spurious halt.
5. **Changelog-commit false-positive (review finding on this issue):** simulate Step 6's land silently failing/no-opping AFTER Step 7.5 has already committed+pushed `docs(changelog): ISS-XX <topic>` to `origin/<productionBranch>`. Confirm Step 8's ancestry check is false (squash tip never lands verbatim) and the diff-presence fallback (`git diff $HEAD_SHA origin/<productionBranch> -- <issue's changed files>`) correctly reports missing hunks → NOT LANDED, even though `origin/<productionBranch>` now contains a commit whose message matches `ISS-XX`. A bare `--grep 'ISS-XX'` fallback (the old wording) would have wrongly matched that changelog commit and reported LANDED with zero code landed — this is why Step 8's fallback is diff-presence, not commit-message grep.

This project's own `forge-test`/`forge-release` overrides are unaffected — `forge-test` already does the real merge + verified push before this skill ever runs here, so Step 4's ancestry check finds `ALREADY_MERGED` and Step 8's gate finds `LANDED` on the first try. Other projects that hold their own project-scoped copy of this template (not this shared default) must be separately reseeded to inherit this fix — tracked as a follow-up, not part of this change.
