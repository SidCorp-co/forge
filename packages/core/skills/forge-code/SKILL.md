---
name: forge-code
description: "Implement code changes for Forge issues. Use this skill whenever approved issues need to be coded — creates branch, follows the plan, implements changes, builds, reviews, commits, and pushes. Triggers on: /forge-code, coding issues, implementing approved issues, writing code for an issue, building features from a plan. Also use when the pipeline needs to move an issue from approved to deploying."
user_invocable: true
arguments: "documentId1 documentId2 ..."
---

# Forge Code

The coding step in the issue pipeline: `approved → developed`. Implements code, validates it locally (build + test), then pushes. An independent review step follows.

When a plan exists (from forge-plan), this skill should be fast and focused — the plan already identified the files, the approach, and the patterns. Don't re-explore. Follow the plan, edit the files, test, commit.

## Usage

```
/forge-code <documentId>
/forge-code <documentId1> <documentId2>
```

## Tools

`forge_issues`, `forge_comments`, `forge_coolify_deploy`, plus codebase tools (Read, Edit, Write, Glob, Grep, Bash).

## Deploy Mode Detection (do this FIRST, once per run)

Before following the workflow below, call `forge_config → get` and `forge_coolify_deploy → list`. Decide **deployMode** for this project:

- **local-only** — `previewDeploy` is null/missing OR has no `stagingUrl`, AND `forge_coolify_deploy → list` returns empty. Project builds only locally; no staging, no production deploy infrastructure.
- **deploy** — Coolify resources are configured OR `previewDeploy.stagingUrl` is set.

The two modes differ only in steps 11 and 13 (push + status). Everything else (branch, build, test, review, commit, session context) is identical.

## Quick Start (Pipeline Mode)

When the issue has a plan and triage/plan comments from Forge AI:

1. Fetch issue + comments → extract plan and complexity from triage. Also detect **deployMode** (see above).
2. **Confirm branch:** Run `git branch --show-current` and `git status`. If on wrong branch or dirty state, stash/clean first.
3. Resolve the base branch, then branch: `git checkout <effectiveBase> && git pull && git checkout -b ISS-XX-short-title`. `<effectiveBase>` is the project `baseBranch` from `forge_config → get` for a normal issue — BUT for a decompose child or parent it is `metadata.branchConfig.baseBranch` (the shared integration branch). See **Decompose-aware branching** below before this step if the issue has `metadata.branchConfig` or `metadata.useIntegrationBranch`.
4. Set `in_progress`
5. Follow plan step-by-step — read each file as you reach it in the plan, edit, move on
6. Build the affected package(s) — infer the build command from the repo (the package's build script / toolchain); catch compile/type errors
7. Test API (if plan has API Test Plan) — curl affected endpoints, verify responses. Skip for frontend-only.
8. Review (tiered — see below) — catch logic bugs
9. Fix any review findings, re-build, re-test
9.5. Simplify the diff (quality-only pass — see Tiered Review below; preserve behavior, stay inside the diff)
10. Commit
11. Push:
    - **local-only mode** — push ISS-* branch only. **Do NOT** merge to baseBranch. **Do NOT** call `forge_coolify_deploy`.
    - **deploy mode** — push ISS-*, merge to baseBranch (Simple/Medium), trigger `forge_coolify_deploy`.
12. Post comment
13. Set status (LAST — triggers next pipeline step):
    - **local-only mode** — always set `developed` (all complexities). Human reviews at `developed` and moves to `closed` (or `reopen`) manually. The pipeline does not advance to `deploying`/`testing`/`staging`/`released` in this mode.
    - **deploy mode** — No preview deploy → `deploying`; Simple (staging URL) → `deploying` with previewUrl; Simple (no staging) / Medium → `deploying`; Complex → `developed`.

**Do NOT:** re-read knowledge.json (plan has the file paths), re-explore the codebase, second-guess the plan, read files that aren't in the plan.

Build and review happen BEFORE push. Only clean, reviewed code gets pushed (and, in deploy mode, deployed).

Read `references/workflow.md` for the full step-by-step including standalone mode.

## Decompose-aware branching (epic children + parent integration)

If the issue has `metadata.branchConfig` or `metadata.useIntegrationBranch`, it is part of a decomposed epic that shares ONE integration branch — branching and the parent integration step differ. **Read `.claude/skills/forge-plan/references/decompose-execution.md` and follow the forge-code section.** In short: a **child** branches off `metadata.branchConfig.baseBranch` (the integration branch, not the project `baseBranch`) — use it as `<effectiveBase>` in step 3; the **parent** (`useIntegrationBranch`) does not write feature code — it `git fetch`es + integration-verifies the integration branch it owns (with fetch+retry, never a base-ancestry guess — the ISS-144 false-negative), does NOT squash to base or deploy, and ends at `developed`.

## Docs-only deliverables (no-code decision / audit / spike)

When the plan calls for a **no-code deliverable** — the issue's output is a decision/audit/spike write-up, not source — the implementation is the document itself, created on the ISS-* branch like any other change:

1. Write the artifact at the planned `docs/proposals/<topic>.md` path and add/refresh its row in `docs/proposals/README.md`. Make it substantive (the actual decision, rationale, and any matrix/recommendations) — a stub will (correctly) be rejected at review.
2. **Skip the build/test matrix.** The mechanical gate is the diff: derive whether this is a source vs docs change from the repo's own structure. If `git diff --name-only <baseBranch>..HEAD` touches **only docs/prose** (no source/code paths), there is nothing to compile or unit-test — the document is the deliverable. If the diff touches any source file, it is NOT docs-only — run the normal build + test + review path.
3. Commit Conventional with a docs scope (e.g. `docs(proposals): ISS-XX <topic>`), body `Resolves ISS-XX`, push the ISS-* branch, comment, set status as usual. Review reads the prose as the reviewable content; it does not treat a docs diff as "nothing to review."

Everything else (branch discipline, status transition, sessionContext) is identical to a normal change.

## Tiered Review

Review effort should match the risk. Over-reviewing trivial changes wastes tokens.

| Complexity | Review (find bugs) | Simplify (clean, quality-only) |
|-----------|--------|------------|
| **Simple** | Self-review: read your diff, check for obvious mistakes | Skip — simplifying a trivial diff is over-engineering |
| **Medium** | Quick review agent: Bug-severity only, skip style | Self pass: skim your diff for obvious reuse / altitude wins |
| **Complex** | Full review agent: Bug + Minor findings | Run the simplifier subagent |

Complexity comes from the triage comment (extracted in Step 2 of the workflow).

### Simplify pass (quality only — separate from bug review)

Simplify happens HERE, in the code lane, because it *modifies* code — the independent review step is report-only and never simplifies. Run it AFTER fixing review findings and BEFORE push, so review and QA see the clean version. Two hard rails:

1. **Preserve behavior exactly** — simplify is reuse / naming / altitude cleanup, not a redesign and not a bug hunt. If you can't explain why a piece of existing code is there, leave it (Chesterton's Fence) — don't delete what you don't understand.
2. **Stay inside the diff** — only simplify code this issue already touches. No adjacent refactors, no "while I'm here" cleanups; that breaks scope discipline and balloons the review surface.

Bug-hunting is the opposite concern and lives elsewhere — your self-review above for obvious mistakes, and the independent gate in forge-review. Keep the two mindsets apart: a simplify pass must not start rewriting logic.

## Pipeline vs Standalone

**Pipeline mode** (has triage/plan comments):
- Plan exists → follow it directly
- ISS-* branch is always kept alive — it is the source of truth for forge-release (in deploy mode) or human close (in local-only mode)
- **local-only mode** (no Coolify, no preview URL): push ISS-* branch only → comment → set `developed` (status LAST) for ALL complexities. No baseBranch merge. No `forge_coolify_deploy` call.
- **deploy mode, no preview deploy configured**: push ISS-*, merge to baseBranch → `forge_coolify_deploy` → comment → set `deploying` (status LAST)
- **deploy mode, Simple (staging URL configured)**: push ISS-*, merge to baseBranch → `forge_coolify_deploy` → comment → set `deploying` with previewUrl (status LAST)
- **deploy mode, Simple (no staging URL) / Medium**: push ISS-* branch → `forge_coolify_deploy` → comment → set `deploying` (status LAST)
- **deploy mode, Complex**: push feature branch → comment → set `developed` (status LAST)

**Standalone mode** (manual invocation, no pipeline comments):
- May not have a plan → explore and self-plan
- Read `.forge/knowledge.json` for conventions
- Exit: `closed`

## Relation Awareness

After fetching the issue, check its `relations` field. If relations exist:

- **`blocked_by` / `depends_on`** — Fetch the blocker. If it's not yet `developed` or beyond, **stop** and post a comment: "Blocked by ISS-XX which is still at [status]. Cannot proceed until it's completed." Set issue back to `confirmed`.
- **`related_to`** — If the related issue is `in_progress` or `developed`, check its branch for overlapping files. If both touch the same files, note it in the commit message and be careful with shared state. Prefer additive changes over modifying shared code.
- **`caused_by`** — Read the linked issue to understand the root cause. Address the underlying problem, not just the symptom.

This takes one extra `forge_issues → get` call per relation — cheap insurance against conflicts.

## Code-specific rules

1. **Plan = source of truth** — don't re-explore or re-plan
2. **Build + review before push** — never push unvalidated code
3. **Post a comment** — see `references/comments.md`

(Status discipline, branch rules, output rules, sessionContext schema — see pipeline preamble.)

## Session Context fields code should populate

Beyond the standard `currentState / decisions / filesModified / errorsResolved`, code step also reads `reviewFeedback` from a prior review (when resuming from `reopen`) and appends entries describing how each finding was addressed. Skip the field if no meaningful work was done.