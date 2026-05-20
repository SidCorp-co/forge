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
3. `forge_config → get` to read `baseBranch`, then `git checkout <baseBranch> && git pull && git checkout -b ISS-XX-short-title`
4. Set `in_progress`
5. Follow plan step-by-step — read each file as you reach it in the plan, edit, move on
6. Run build (`npm run build`) — catch compile/type errors
7. Test API (if plan has API Test Plan) — curl affected endpoints, verify responses. Skip for frontend-only.
8. Review (tiered — see below) — catch logic bugs
9. Fix any review findings, re-build, re-test
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

## Tiered Review

Review effort should match the risk. Over-reviewing trivial changes wastes tokens.

| Complexity | Review | Simplifier |
|-----------|--------|------------|
| **Simple** | Self-review: read your diff, check for obvious mistakes | Skip |
| **Medium** | Quick review agent: Bug-severity only, skip style | Skip |
| **Complex** | Full review agent: Bug + Minor findings | Run simplifier |

Complexity comes from the triage comment (extracted in Step 2 of the workflow).

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