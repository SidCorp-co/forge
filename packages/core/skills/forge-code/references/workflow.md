# Code Implementation Workflow

## Step 1: Fetch Issue Data

Fetch the issue and its comments in parallel:

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
```

For multiple issues, fetch all in parallel.

## Step 2: Determine Mode & Complexity

Check comments for pipeline artifacts:
- **Triage comment** (starts with `**Triage**`) → pipeline mode, extract complexity (`xs/s/m/l/xl`)
- **Plan comment** (starts with `**Plan**`) → has forge-plan output

**Pipeline mode** (has triage/plan comments): deploy mode merges **every** complexity to `baseBranch` + `forge_coolify_deploy`, then exits `xs/s` → `testing` (set staging previewUrl) and `m/l/xl` → `developed` (independent review, then testing); local-only pushes the ISS-* branch only and exits `developed`. **Never `deploying`** (retired). See Steps 13 + 15.
**Standalone mode** (no pipeline comments): exit as `closed`

## Step 3: Check Actionability

If no plan AND the issue is vague → set `needs_info`, post comment, stop.

If plan exists, skip this — the plan proves it's actionable.

## Step 4: Confirm Branch & Create Feature Branch

First confirm current git state — in pipeline-resumed sessions the working tree may be on an unexpected branch from a previous step:

```bash
git branch --show-current
git status
```

If there are uncommitted changes, stash them: `git stash`. If on a stale branch, note it for cleanup.

Then fetch the project's base branch from config and create the feature branch:

```
forge_config → get → {}
```

Use the `baseBranch` value (defaults to `main`):

```bash
git checkout <baseBranch> && git pull origin <baseBranch> && git checkout -b ISS-XX-short-title
```

## Step 5: Read Context (Conditional)

**If plan has file paths** (pipeline mode): Skip the file-map lookup. The plan already tells you which files to touch and what patterns to follow. Go straight to implementation.

**If no plan** (standalone mode): Look up conventions via project knowledge (`forge_knowledge`) and recall prior gotchas via `forge_memory.search` — there is no local `knowledge.json`/`lessons.md` file.

**Attachments**: If the issue has `attachments` (screenshots, mockups, files), read them using the Read tool (images) or WebFetch (URLs). Screenshots show the bug or desired UI — use them to understand what the user actually sees.

## Step 6: Set In Progress

```
forge_issues → update → { documentId: "<id>", data: { status: "in_progress" } }
```

## Step 7: Implement

**If plan exists:** Follow it step-by-step. Read each file as you get to it — don't pre-read everything upfront. The plan lists the file, what to change, and why.

**If no plan:** Explore the affected area using project-knowledge paths, then implement.

Either way:
- Follow acceptance criteria
- Match existing patterns
- Minimal changes only — don't refactor outside scope

## Step 8: Build

Run the project's build to catch compile/type errors before review:
- Infer the build command from the repo (the affected package's build script / toolchain) and run it from the correct package directory
- Fix any build errors before proceeding
- This catches issues that would fail CI later

## Step 9: Test

**API changes:** If the plan has an **API Test Plan** section, run those tests against the local dev server (curl/fetch the affected endpoints, verify status codes and response shape). Fix failures before proceeding.

**No API changes (frontend-only):** Skip this step — the build (Step 8) is sufficient. Frontend testing is handled by QA (forge-test) against the preview deployment.

## Step 10: Review (Tiered by Complexity)

Review happens BEFORE commit and push. This catches logic bugs early — only clean code gets pushed.

Review depth scales with risk. Over-reviewing simple changes wastes tokens without catching real issues.

**xs / s complexity (from triage):** Self-review only. Re-read your diff (`git diff`), check for obvious mistakes (typos, missing imports, wrong variable names). No subagent needed — the change is too small to benefit from fresh-context review.

**m complexity:** Quick review. Launch review agent but scope it tightly:

```
Agent → subagent_type: "general-purpose"
  mode: "bypassPermissions"
  prompt: "Quick code review. Read .claude/skills/forge-review/SKILL.md. Review the uncommitted changes. Focus only on Bug-severity issues — skip style and minor items. Issue: ISS-XX: <title>"
```

Fix any Bug findings. Skip Minor/Low.

**l / xl complexity:** Full review. Launch the standard review agent:

```
Agent → subagent_type: "general-purpose"
  mode: "bypassPermissions"
  prompt: "You are a code reviewer. Read .claude/skills/forge-review/SKILL.md and follow it exactly. Review the uncommitted changes. Issue: ISS-XX: <title>"
```

Fix Bug and Minor findings. Skip Low unless trivial.

If fixes were needed, re-run build + test (Steps 8-9) before proceeding.

## Step 11: Simplify (l / xl Only)

Only run the code simplifier for **`l`/`xl`** issues where there's enough new code to benefit from refactoring. For `xs/s/m`, the change is small enough that simplification adds cost without value.

```
Agent → subagent_type: "code-simplifier"
  mode: "bypassPermissions"
  prompt: "Simplify recently modified code. Focus on files changed in the working tree."
```

## Step 12: Commit

- Conventional commit: `feat:`, `fix:`, `refactor:`, etc.
- Reference issue ID: `Resolves ISS-XX`
- Stage specific files — avoid `git add .`

## Step 13: Push & Deploy

**Key principle:** The ISS-* feature branch is always kept alive through the pipeline — it is the single source of truth that forge-release squash-merges to the **production** branch at the end. `baseBranch` is staging (≠ production), so merging there is safe for **every** complexity and is exactly what makes the change reachable for QA. (This replaces the old "Complex doesn't merge until review" rule — that left large issues unreachable on a no-preview project.)

**Deploy mode (Coolify configured OR `previewDeploy.stagingUrl` set) — ALL complexities:** push the ISS-* branch, merge it into `baseBranch`, push base, then deploy.

```bash
git push -u origin ISS-XX-short-title
git checkout <baseBranch>
git merge ISS-XX-short-title
git push origin <baseBranch>
git checkout ISS-XX-short-title
```

```
forge_coolify_deploy → deploy → { issueId: <current issue documentId> }
```

**Decompose child/parent are the exception** — they target the integration branch, not `baseBranch` (child merges to it; parent integrate-verifies, doesn't merge here). See `.claude/skills/forge-plan/references/decompose-execution.md`.

**Local-only mode (no Coolify AND no staging URL):** push the ISS-* branch only — no `baseBranch` merge, no deploy.

```bash
git push -u origin ISS-XX-short-title
```

## Step 14: Post Comment

Post a summary on the issue (see `references/comments.md` for style):

```
forge_comments → create → { data: { body: "<markdown>", issue: "<documentId>", author: "Charizard" } }
```

What was implemented, notable decisions. No file paths or code snippets.

## Step 15: Set Status (LAST)

**Status update must be the LAST action.** It triggers downstream pipeline steps, so all work (push, deploy, comment) must complete first. `deploying` was **retired** — the only valid exits from the code step are `developed`, `testing`, or `reopen`.

**Deploy mode, `xs` / `s`** — skip independent review, go straight to QA on the deployed staging build:
```
forge_issues → update → { documentId: "<id>", data: { status: "testing", previewUrl: "<stagingUrl>", previewApiUrl: "<stagingApiUrl>", previewStatus: "live" } }
```

**Deploy mode, `m` / `l` / `xl`** — the independent forge-review stage runs at `developed`, then advances to testing:
```
forge_issues → update → { documentId: "<id>", data: { status: "developed" } }
```

**Local-only mode (any complexity)** — human reviews at `developed` and closes manually:
```
forge_issues → update → { documentId: "<id>", data: { status: "developed" } }
```

## Step 16: Capture Learnings

If you discovered a genuine, reusable learning (convention, gotcha, fix-pattern), capture it via `forge_memory` — search first (`sourceFilter: ['knowledge']`), then `write` with `source: 'knowledge'` and a stable kebab `sourceRef` so it refines rather than duplicates. Not a local file.
