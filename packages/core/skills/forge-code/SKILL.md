---
name: forge-code
description: "Implement code changes for Forge issues. Use this skill whenever approved issues need to be coded — creates branch, follows the plan, implements changes, builds, reviews, commits, and pushes. Triggers on: /forge-code, coding issues, implementing approved issues, writing code for an issue, building features from a plan. Also use when the pipeline needs to move an issue from approved to developed."
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

> **Pull-model note:** On large issues `forge_step_start` returns a lean manifest (`bodyTruncated:true`). Fetch `plan`/`description`/`acceptanceCriteria` as needed via `forge_issues.get { documentId, fields: ['plan'] }` rather than assuming full body is present.

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
11. Push — see the **Push & exit matrix** below:
    - **deploy mode** — push the ISS-* branch, merge it into `baseBranch`, then trigger `forge_coolify_deploy`. **Every complexity merges to `baseBranch` and deploys** — `baseBranch` is staging (≠ the production branch), so getting the change onto a reachable, QA-able environment is the point. Keep the ISS-* branch alive (release promotes it to prod).
    - **local-only mode** — push the ISS-* branch only; **no** `baseBranch` merge, **no** `forge_coolify_deploy`.
    - **decompose child/parent** — different base/target branch; see **Decompose-aware branching** above (child → integration branch, no deploy; parent → integrate-verify, no merge).
12. Post comment
13. Set status LAST (triggers the next step). **Never set `deploying` — it was retired from the lifecycle; the only valid exits from the code step are `developed` or `testing`.**
    - **deploy mode** — `xs`/`s` → **`testing`** (skip independent review — the inline self-review is enough for a trivial change; set `previewUrl`/`previewApiUrl` to the staging URLs). `m`/`l`/`xl` → **`developed`** (independent forge-review runs, then advances to testing).
    - **local-only mode** — **`developed`** for ALL complexities (human reviews at `developed` and closes manually).

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

| Complexity | Inline review (find bugs, pre-push) | Simplify (quality-only) |
|-----------|--------|------------|
| **xs / s** | Self-review: read your diff, check for obvious mistakes | Skip — simplifying a trivial diff is over-engineering |
| **m** | Quick review agent: Bug-severity only, skip style | Self pass: skim your diff for obvious reuse / altitude wins |
| **l / xl** | Full review agent: Bug + Minor findings | Run the simplifier subagent |

Complexity comes from the triage comment (extracted in Step 2 of the workflow). This is the **inline** pre-push review; `m`/`l`/`xl` additionally get the **independent** forge-review stage at `developed` (xs/s skip it — they exit straight to `testing`).

### Simplify pass (quality only — separate from bug review)

Simplify happens HERE, in the code lane, because it *modifies* code — the independent review step is report-only and never simplifies. Run it AFTER fixing review findings and BEFORE push, so review and QA see the clean version. Two hard rails:

1. **Preserve behavior exactly** — simplify is reuse / naming / altitude cleanup, not a redesign and not a bug hunt. If you can't explain why a piece of existing code is there, leave it (Chesterton's Fence) — don't delete what you don't understand.
2. **Stay inside the diff** — only simplify code this issue already touches. No adjacent refactors, no "while I'm here" cleanups; that breaks scope discipline and balloons the review surface.

Bug-hunting is the opposite concern and lives elsewhere — your self-review above for obvious mistakes, and the independent gate in forge-review. Keep the two mindsets apart: a simplify pass must not start rewriting logic.

## Pipeline vs Standalone

**Pipeline mode** (has triage/plan comments):
- Plan exists → follow it directly.
- The ISS-* branch is always kept alive — it is the source of truth that forge-release promotes to the production branch (deploy mode) or that a human closes (local-only).
- Push + exit status follow the single **Push & exit matrix** (Quick Start steps 11–13): deploy mode merges **every** complexity to `baseBranch` + deploys, then exits `xs/s` → `testing` and `m/l/xl` → `developed`; local-only pushes the branch only and exits `developed`. **Never `deploying`** (retired).

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