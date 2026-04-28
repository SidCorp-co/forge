---
name: forge-plan
description: "Write implementation plans for confirmed Forge issues. Use this skill whenever an issue needs a plan before coding begins — exploring the codebase, identifying affected files, and writing step-by-step implementation instructions into the issue's plan field. Triggers on: /forge-plan, planning issues, writing implementation plans, exploring codebase for an issue, preparing issues for development, moving issues from confirmed to approved. Also use when the pipeline needs to advance an issue from confirmed status."
user_invocable: true
arguments: "documentId"
---

# Forge Plan

This is the second step in the issue pipeline: `confirmed → approved`. Its job is to turn a triaged issue into a concrete implementation plan that a coding agent (or developer) can follow without re-exploring the codebase.

Planning is the highest-value step in the pipeline. A good plan saves the coding step from wasting tokens on exploration, wrong turns, and rework. A bad plan (or no plan) means the coding agent explores blindly, makes architectural mistakes, and produces code that needs heavy review.

## Usage

```
/forge-plan <documentId>
```

## Tools

- **forge_issues** — get issue data, write plan back to `plan` field
- **forge_comments** — read triage comment (complexity), post plan comment
- **Codebase tools** — Read, Glob, Grep for exploring the actual code

## Two-Tier Planning

Not every issue needs deep codebase exploration. The planning depth should match the complexity:

**Lightweight plan (Simple/Medium):** Use `knowledge.json` + issue description + targeted Glob to identify files and write the plan. Read at most 1-2 source files — only when you need to check an existing pattern or verify a component's current props/API. The coding agent will read the files during implementation anyway, so duplicate deep-reading wastes tokens.

**Deep plan (Complex):** Full codebase exploration. Read all affected files, trace dependencies, verify patterns. Complex issues involve architectural decisions where a wrong plan costs more than the exploration.

The tier is determined by the triage comment's complexity classification.

## Workflow

### Step 1: Fetch Issue & Triage Context

Fetch the issue and its comments in parallel:

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
forge_config → get
```

Verify status is `confirmed`. If the issue isn't confirmed yet, stop and explain — planning an untriaged issue skips the completeness check and risks wasting exploration time on an incomplete issue.

Find the triage comment (starts with `**Triage**`) and extract the **complexity** classification. This determines both the planning depth and the exit behavior.

**Checkout latest baseBranch** so exploration sees the current production code:

```bash
git fetch origin
git checkout <baseBranch> && git pull origin <baseBranch>
```

Use the `baseBranch` from `forge_config` (defaults to `main`). This ensures the plan is based on the latest merged code, not a stale feature branch.

### Step 2: Understand the Issue

Read everything available:
- title, description — what needs to change
- acceptanceCriteria / aiAcceptanceCriteria — what "done" looks like
- suggestedSolution / aiSuggestedSolution — proposed approach (if any)
- Triage comment — complexity and category context
- **attachments** — screenshots, mockups, or files the user uploaded. If the issue has `attachments` (array of `{name, mime, url}`), **fetch and read each one** using the Read tool (for images) or WebFetch (for other files). Screenshots often show the bug or desired UI — they are critical context that the description alone may not capture.
- **relations** — check the issue's `relations` field for linked issues

Synthesize: **what area of the system is affected, what the change should accomplish, and what constraints exist.**

#### Handle Relations

If the issue has relations, fetch each related issue to understand the context:

```
forge_issues → get → { documentId: "<related docId>" }
```

How to use each relation type:

- **`blocked_by` / `depends_on`** — Check the blocker's status. If it's not yet `developed` or beyond, **flag it in the plan** as a prerequisite. The plan should note which parts depend on the blocker's output (schema changes, new APIs, shared components). If the blocker is already completed, read its plan to understand what was built and build on top of it.
- **`related_to`** — Read the related issue's plan (if it has one) or description. Identify **overlapping files** — if both issues touch the same files, the plan must account for potential merge conflicts. Note which files overlap and how changes should be coordinated.
- **`duplicate_of`** — Shouldn't reach planning (triage sets `needs_info`). If it does, stop and post a comment pointing to the original.
- **`caused_by` / `fixed_by`** — Read the linked issue for root cause context. Factor the underlying cause into the plan to avoid a surface-level fix.

Include a **Relations** section in the plan when relations affect implementation (overlapping files, dependencies, ordering constraints). Skip it when relations are purely informational.

### Step 3: Build the File Map

Read `.forge/knowledge.json` to resolve the issue into concrete file paths:

```
Read: .forge/knowledge.json
```

Use it to:
- Look up `paths` to find exact file locations (e.g., `paths.frontend-feature` → `web/src/features/{domain}/`)
- Check `domains` to identify which content types are involved
- Check `recipes` — if a recipe matches the issue type (new endpoint, new page, new tool), it provides the implementation steps template
- Reference `conventions` for naming and state management patterns

Then use targeted Glob to confirm the files exist and find exact paths:

```
Glob: packages/<package>/src/**/*<keyword>*
```

### Step 4: Explore (Depth Depends on Tier)

**For Simple/Medium (lightweight):**
- You now have the file list from knowledge.json + Glob. That's usually enough.
- Only read a source file if you need to check: a component's current props/API, an existing pattern to reference, or whether a utility already exists.
- Limit to 1-2 file reads max. The coding agent will read everything during implementation.

**For Complex (deep):**
- Read `references/exploration-guide.md` for the full exploration approach.
- Read all affected files to understand current state.
- Follow the data flow — trace from API to UI or vice versa.
- Check for shared dependencies — Grep for imports of any types/utilities you plan to change.
- Read existing tests to understand testing patterns.

### Step 5: Write the Plan

Write the implementation plan following the format in `references/plan-format.md`. The plan goes into the issue's `plan` field:

```
forge_issues → update → { documentId: "<id>", data: { plan: "<markdown plan>" } }
```

**For lightweight plans:** Focus on the **what** — which files, what changes, what approach. The coding agent will figure out the **how** when it reads the code. Reference knowledge.json recipes when applicable.

**For deep plans:** Be concrete about both **what** and **how** — file paths, function names, pattern references. The coding agent should be able to follow the plan step-by-step without re-exploring.

### Step 6: Validate the Plan

Before posting, sanity-check:
- Does every file in "Affected Files" actually exist? (Glob to verify — you may already know from Step 3)
- Do the implementation steps cover all acceptance criteria?
- Are there any obvious risks or edge cases not addressed?

Skip checking test files for lightweight plans — the coding agent handles testing.

### Step 7: Post Comment & Set Status

The exit behavior depends on complexity (from the triage comment, extracted in Step 1):

**Simple or Medium complexity:**
```
forge_comments → create → { data: { body: "<plan comment>", issue: "<documentId>", author: "Alakazam" } }
forge_issues → update → { documentId: "<id>", data: { status: "approved" } }
```

Auto-approving simple/medium plans keeps the pipeline fast. **Status update is LAST** — it triggers the coding step.

**Complex complexity:**
```
forge_comments → create → { data: { body: "<plan comment>", issue: "<documentId>", author: "Alakazam" } }
forge_issues → update → { documentId: "<id>", data: { status: "waiting" } }
```

Set status to `waiting` — Complex issues wait for a human to review the plan and manually approve. **Status update is LAST.**

**If no triage comment found** (manual invocation, not from pipeline):
- Default to auto-approve behavior (treat as Medium)

### Plan Comment Format

```markdown
**Plan** — <one-line summary of the approach>

**Affected files:** <count> files in <package(s)>
**Status:** <Auto-approved / Awaiting human approval>

The full plan has been written to the issue's plan field.
```

Keep the comment short — the full plan lives in the `plan` field, not the comment. The comment is just a notification for humans and downstream skills.

## Output Rules (Save Tokens)

- **Zero narration.** Do not say what you're about to do or what you just did. Tool calls are self-documenting.
- **No quoting files.** After reading a file or knowledge.json, don't repeat its contents. Extract what you need silently and write the plan.
- **One-line status only.** "Plan written, setting approved." — nothing more.
- **Plan goes to the API, not to chat.** Write the plan via `forge_issues → update`. Don't also print it in the conversation — that doubles the tokens for zero value.
