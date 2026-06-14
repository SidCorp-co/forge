---
name: forge-plan
description: "Write implementation plans for clarified Forge issues. Use this skill whenever an issue needs a plan before coding begins — exploring the codebase, identifying affected files, and writing step-by-step implementation instructions into the issue's plan field. Triggers on: /forge-plan, planning issues, writing implementation plans, exploring codebase for an issue, preparing issues for development, moving issues from clarified to approved. Also use when the pipeline needs to advance an issue from clarified status."
user_invocable: true
arguments: "documentId"
---

# Forge Plan

This is the planning step in the issue pipeline: `clarified → approved` (it runs after triage and clarify). Its job is to turn a triaged, reproduced issue into a concrete implementation plan that a coding agent (or developer) can follow without re-exploring the codebase.

Planning is the highest-value step in the pipeline. A good plan saves the coding step from wasting tokens on exploration, wrong turns, and rework. A bad plan (or no plan) means the coding agent explores blindly, makes architectural mistakes, and produces code that needs heavy review.

## Usage

```
/forge-plan <documentId>
```

## Tools

`forge_issues`, `forge_comments`, plus codebase exploration tools (Read, Glob, Grep).

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

Verify status is `clarified`. If the issue isn't clarified yet, stop and explain — planning before triage + clarify skips the completeness and reproduction checks and risks wasting exploration time on an incompletely-understood issue.

Find the triage comment (starts with `**Triage**`) and extract the **complexity** classification — it sets both planning depth and exit behavior. Then read the **clarify** findings (comment + step handoff, present unless clarify was skipped for an xs/s issue): the reproduction outcome, the environment tested, and a code-level **root-cause hypothesis**. Trust clarify's verified behavior over re-deriving the problem from the description — plan the fix for the confirmed root cause, not the reported symptom.

Checkout the latest baseBranch (from `forge_config`, see preamble for the detection rule) so exploration sees current production code.

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

#### No-code deliverables (decision / audit / spike)

Some issues ship **no source code** — their only deliverable is a *decision* (a port-or-drop matrix, an architecture audit, a spike conclusion). With nothing to commit, the issue would stall: code produces no branch, review has no diff, test/release have nothing to merge or close — a re-dispatch loop.

Make the decision a **mergeable artifact** instead. Plan an in-repo markdown document and treat it exactly like code:

- Classify an issue as a no-code deliverable only when its acceptanceCriteria/goal is purely a decision/audit/spike write-up with **no** source, UI, API, or schema change. When in doubt, plan it as normal code — this is a narrow class, not a catch-all for "has some docs."
- The deliverable is a doc at **`docs/proposals/<topic>.md`** (short, kebab, topic-focused), added to the index in `docs/proposals/README.md`. Name the exact path in the plan and outline the required sections so the coding step writes substantive content, not a stub.
- This makes the change a **docs-only diff** (touches only `docs/**`, no `packages/**`), which flows code → review → test → release like any other change. The coding/review/test steps key off that mechanical signal, so a real decision becomes a durable, discoverable artifact rather than a comment that vanishes from the codebase.
- Do **NOT** decompose a no-code deliverable (see Step 5.5). Recommended follow-ups (e.g. ports the decision endorses) spin off as **standalone** issues linked with a soft `related_to` — never as `decomposes` children, since a pure decision has nothing to integrate.

### Step 5.5: Decide whether to decompose (Complex epics only)

For Complex issues with **>3 parallel workstreams** that each ship independently, split the epic into a parent + children using `kind='decomposes'` dependency edges. The lifecycle hooks in `pipeline/decomposition-subscribers.ts` then automate cascade approve, the all-children-ready watcher, atomic release gating, and close cascade.

**When to decompose:**
- Each child must be reviewable + testable independently.
- Cap at 6-8 children per epic — worker reliability degrades beyond that.
- The parent must have a meaningful integration-test step after all children land (otherwise just use `blocks` dependencies — the watcher exists specifically to re-fire integration tests on the parent).
- Workstreams should not share critical code paths that will collide at PR-merge time.

**When NOT to decompose:**
- Single-file changes, refactors localized to one module, bug fixes.
- **No-code deliverables** (decision/audit/spike, docs-only — see above): never decompose, regardless of how many recommendations they contain. A pure decision has nothing to integrate; endorsed follow-ups become standalone `related_to` issues.
- Items where one child's failure should not block siblings' release — the gate is atomic by design.
- Nested decomposition (epic → epic → story). Single-level only for v1.

**How to decompose:**

1. For each child workstream, create a child issue:
   ```
   forge_issues → create → { data: { title: "<child slice title>", description: "<scoped description>", status: "on_hold", priority: <inherit>, category: <inherit> } }
   ```
   Children land at `on_hold` so the orchestrator does NOT auto-dispatch forge-triage. The cascade-approve hook on parent `waiting → approved` flips them to `approved` and the normal pipeline resumes.

2. For each created child, add a `decomposes` dependency edge with the parent as the `from` side via the MCP tool:
   ```
   forge_project_pm → {
     action: "set_dependency",
     projectId: "<projectId>",
     fromIssueId: "<parentId>",
     toIssueId:   "<childId>",
     kind: "decomposes"
   }
   ```
   `projectId` is the one you already read in Step 1 via `forge_config → get` (`response.project.id`). The tool is idempotent on `(projectId, fromIssueId, toIssueId, kind)` so re-runs are safe — it returns `{ id, created: true|false }` and only emits the `dependencyChanged` hook on first insert.

   **If the parent's plan declares sibling-blocks ordering** (e.g., Sub 2 must wait for Sub 1 to ship before its `forge-triage` dispatches), add those edges immediately after creating all children:
   ```
   forge_project_pm → {
     action: "set_dependency",
     projectId: "<projectId>",
     fromIssueId: "<sub1Id>",    // the issue that ships FIRST
     toIssueId:   "<sub2Id>",    // the issue that WAITS
     kind: "blocks"
   }
   ```
   Verify each call returns `{ id, created: true|false }`. If a call throws `FORBIDDEN` or `CYCLE_DETECTED`, stop and post a comment — silently writing "Added blocks edges" in the plan text without the rows landing is the failure mode that caused ISS-131. Never claim a dependency in plan prose unless the MCP call succeeded.

3. Write the parent's `plan` field with one section per child — title, scope, files, acceptance criteria. The parent plan is the index; each child's own `description` carries the child-specific implementation detail.

4. Do **NOT** set the parent's status yourself. `decomposeParent` (core) atomically parks the parent at `status: 'waiting'` (the review gate) and creates the children at `draft`. State control for decompose lives in core, not in this skill — manually overriding the parent status is the drift that breaks the kickoff. A human reviews the decomposition before approving.

5. Post a plan comment summarizing the decomposition decision and rationale: which children, why this split, what the parent's integration test will verify.

**What happens after human approval (automatic, all system-owned):**
- Parent enters `approved` → the cascade flips every `draft` child → `approved` simultaneously.
- Children run their pipelines in parallel through code → review → test → released → closed. Children do NOT wait for the parent.
- The parent sits at `approved` but its forward jobs (code/review/test/fix) are held by the `decomposeChildrenPending` dispatch gate until EVERY child has landed on the base branch (`child.merged_at` set, i.e. child reached `closed`).
- Once all children are merged, the gate clears and the parent runs its integration work LAST (code → … → released → closed). The parent merges after its children.
- Parent → `closed` forces any non-closed children to `closed` (clean-up when the epic is abandoned).

**Verifying sibling-blocks edges took effect (ISS-131 breadcrumb):**
The L2 dispatcher gate evaluates `blocks` parents at dispatch time for every job type (not just `release`). When a downstream child's `forge-triage` job is queued behind a non-terminal blocker, the child's `agent_sessions` row stays at `status='queued'` with `failure_reason='waiting_on_dep'` and `metadata.waitingOn` listing the blocking parents. If after cascade-approve you see every child's `forge-triage` immediately dispatch in parallel, the most likely cause is that `forge_project_pm (set_dependency)` never ran or threw silently — go back and re-call it for each declared blocks edge.

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

## Plan-specific output reminder

The plan goes to the API (`forge_issues → update` on the `plan` field), NOT to chat output. Don't print it twice. (See pipeline preamble for general output rules.)
