---
name: forge-plan
description: "Write implementation plans for confirmed Forge issues. Use this skill whenever an issue needs a plan before coding begins — exploring the codebase, identifying affected files, and writing step-by-step implementation instructions into the issue's plan field. Triggers on: /forge-plan, planning issues, writing implementation plans, exploring codebase for an issue, preparing issues for development, moving issues from confirmed to approved. Also use when the pipeline needs to advance an issue from confirmed status."
user_invocable: true
arguments: "documentId"
---

# Forge Plan

## English-only output (project rule, non-negotiable)

This project is Apache-2.0 OSS targeting an English-speaking audience. Regardless of what language the issue's `description`, `acceptanceCriteria`, or `comments` are written in (Vietnamese, French, etc.), every byte you write back to the issue's `plan` field — and every code/string/comment a downstream coding agent might lift verbatim from your plan — MUST be in English.

Specifically:
- All UI strings in the plan (toast text, error messages, button labels, placeholders, empty-state copy) must be quoted in English. Never `flash('err', 'Đợi 2s rồi click lại')` — write `flash('err', 'Wait 2s before clicking again')`.
- Variable names, comments, log messages, commit messages: English.
- Translate any user-supplied wording into English before embedding it in the plan.
- If the issue's description is in another language, you may briefly summarise the user's intent in English at the top of the plan, but do NOT carry the source language into proposed code or copy.

This rule exists because past issues (ISS-43) leaked ~33 lines of Vietnamese into the production web UI on `main` because the plan was written in the user's language and a coding agent implemented it verbatim. We are not paying that cleanup cost again.

---

This is the second step in the issue pipeline: `confirmed → approved`. Its job is to turn a triaged issue into a concrete implementation plan that a coding agent (or developer) can follow without re-exploring the codebase.

Planning is the highest-value step in the pipeline. A good plan saves the coding step from wasting tokens on exploration, wrong turns, and rework.

## Usage

```
/forge-plan <documentId>
```

## Tools

- **forge_issues** — get issue data, write plan back to `plan` field
- **forge_comments** — read triage comment (complexity), post plan comment
- **forge_config** — get base branch
- **Codebase tools** — Read, Glob, Grep for exploring the actual code

## Two-Tier Planning

**Lightweight plan (Simple/Medium):** Use `knowledge.json` + issue description + targeted Glob to identify files and write the plan. Read at most 1-2 source files.

**Deep plan (Complex):** Full codebase exploration. Read all affected files, trace dependencies, verify patterns.

The tier is determined by the triage comment's complexity classification.

## Status Transitions (what Step 6 sets)

| Complexity | Status set | Trigger |
|---|---|---|
| Simple / Medium | `approved` | auto-approved — forge-code dispatches immediately |
| Complex atomic (not decomposed) | `waiting` | human reviews + approves before code starts |
| Complex composite (decomposed — see Step 5.5) | `waiting` + children at `on_hold` | parent approval cascades all children to `approved` |

## User-facing rule (mandatory)

If a feature is **user-visible** (UI, dashboard, settings page, public API), the plan MUST cover both backend AND frontend slices. A backend-only plan for a user-facing feature is incomplete — factor the frontend scope into complexity assessment. If `acceptanceCriteria` mentions "visible in UI", "user can see/do X", or similar, frontend coverage is required.

## Workflow

### Step 1: Fetch Issue & Triage Context

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
forge_config → get
```

Verify status is `confirmed`. Find the triage comment and extract complexity.

**Checkout latest baseBranch:**

Fetch the resolved value from `forge_config` (PR-A) before running git, so issues with a non-default base (decomposed-epic integration branches, hotfix bases) check out the right starting point:

```bash
BASE=$(forge_config get --projectId "$PROJECT_ID" --issueId "$DOCUMENT_ID" \
  | jq -r '.config.branchConfig.baseBranch // .config.baseBranch // "main"')
REMOTE=$(git remote | head -1)
git fetch "$REMOTE" "$BASE"
git checkout "$BASE" && git pull "$REMOTE" "$BASE"
```

The `// .config.baseBranch // "main"` chain in jq is the fallback ladder: PR-A's resolver, then the legacy project default, then the hard default — same precedence as the resolver itself, so behaviour is identical for non-overridden issues.

### Step 2: Understand the Issue

Read everything: title, description, acceptanceCriteria, suggestedSolution, triage comment, attachments, relations.

Synthesize: **what area is affected, what should change, what constraints exist.**

### Step 3: Build the File Map

Read `.forge/knowledge.json` to resolve the issue into concrete file paths. Use targeted Glob to confirm.

### Step 4: Explore (Depth Depends on Tier)

**Simple/Medium**: file list from knowledge.json + Glob is usually enough. Read 1-2 files max.

**Complex**: read all affected files, trace data flow, check for shared dependencies via Grep.

### Step 4.5: Handle Relations (only if implementation depends on them)

Issue dependencies live in `issue_dependencies` table with `kind`:

| Kind | Pipeline behavior | When relevant to plan |
|---|---|---|
| `blocks` | L2 dispatcher gate — blocker must reach `released`/`closed`/`pipeline_failed` before this issue dispatches | Note ordering in plan if this issue depends on another shipping first |
| `decomposes` | Decomposition lifecycle (cascade approve, watcher, atomic release) — see Step 5.5 | Only when planning the parent epic |
| `relates`, `duplicates`, `parent` | PM/UX metadata only — no pipeline action | Skip unless it's actually a hard dependency (then use `blocks`) |

**Include a `## Relations` section in the plan ONLY when** dependencies affect implementation:

- **Shared types / API contracts** — the other issue changes a type this plan consumes; coordinate ordering.
- **Ordering required** — another issue MUST land first (verify it's a `blocks` edge, not `relates`).
- **Duplicate / superseded** — mark `duplicates` and stop planning; link to the canonical issue.

Skip the section for `relates` links that are just context — don't pad the plan with traceability-only relations.

**Writing the Relations section:**
```markdown
## Relations
- **blocks ISS-xxx** (<title>) — <why it blocks and what lands first>
- **duplicates ISS-yyy** — <link to canonical>
```

One line per relation, consequence spelled out.

**Adding a dependency** (only do this if the plan reveals a new ordering constraint not already captured) — use the MCP tool, NOT a REST endpoint (plan agents have no HTTP fetch):
```
forge_pm_set_dependency → {
  projectId: "<projectId>",
  fromIssueId: "<blocker>",    // must reach released/closed/pipeline_failed first
  toIssueId:   "<blocked>",    // waits at L2 with failure_reason='waiting_on_dep'
  kind: "blocks"
}
```
`projectId` comes from `forge_config → get → response.project.id` already fetched in Step 1. The tool is idempotent on `(projectId, fromIssueId, toIssueId, kind)` — duplicate calls return `{ id, created: false }`. For `decomposes`, use the Step 5.5 workflow — children + parent atomically.

### Step 5: Write the Plan

```
forge_issues → update → { documentId: "<id>", data: { plan: "<markdown plan>" } }
```

**For lightweight plans:** focus on **what** — files, changes, approach.

**For deep plans:** be concrete about **what** and **how** — file paths, function names, pattern references.

### Step 5.5: Decide whether to decompose (Complex epics only)

For Complex issues with **>3 parallel workstreams** that each ship independently, split the epic into a parent + children using `kind='decomposes'` dependency edges. The lifecycle hooks in `pipeline/decomposition-subscribers.ts` automate cascade approve, the all-children-ready watcher, atomic release gating, and close cascade.

**When to decompose:**
- Each child must be reviewable + testable independently.
- Cap at 6-8 children per epic — worker reliability degrades beyond that.
- The parent must have a meaningful integration-test step after all children land (otherwise just use `blocks` dependencies — the watcher exists specifically to re-fire integration tests on the parent).
- Workstreams should not share critical code paths that will collide at PR-merge time.

**When NOT to decompose:**
- Single-file changes, refactors localized to one module, bug fixes.
- Items where one child's failure should not block siblings' release — the gate is atomic by design.
- Nested decomposition (epic → epic → story). Single-level only for v1.

**How to decompose:**

1. For each child workstream, create a child issue:
   ```
   forge_issues → create → { data: { title: "<child slice title>", description: "<scoped description>", status: "on_hold", priority: <inherit>, category: <inherit>, manualHold: false } }
   ```
   Children land at `on_hold` so the orchestrator does NOT auto-dispatch forge-triage. The cascade-approve hook on parent `waiting → approved` flips them to `approved` and the normal pipeline resumes. Do NOT use `manualHold: true` for parking — see [[feedback_manualhold_trap]].

2. For each created child, add a `decomposes` dependency edge with the parent as the `from` side via the MCP tool:
   ```
   forge_pm_set_dependency → {
     projectId: "<projectId>",
     fromIssueId: "<parentId>",
     toIssueId:   "<childId>",
     kind: "decomposes"
   }
   ```
   `projectId` is the one from `forge_config → get` in Step 1. The tool is idempotent and returns `{ id, created: true|false }`.

   **If the parent's plan declares sibling-blocks ordering** (e.g., Sub 2 must wait for Sub 1's pipeline to finish before its `forge-triage` dispatches), add those edges immediately after creating all children:
   ```
   forge_pm_set_dependency → {
     projectId: "<projectId>",
     fromIssueId: "<sub1Id>",    // the issue that ships FIRST
     toIssueId:   "<sub2Id>",    // the issue that WAITS
     kind: "blocks"
   }
   ```
   Verify each call returns `{ id, created: true|false }`. If any throws `FORBIDDEN` or `CYCLE_DETECTED`, stop and post a comment — silently writing "Added blocks edges" in the plan text without the rows landing is the failure mode that caused ISS-131. Never claim a dependency in plan prose unless the MCP call succeeded.

3. Write the parent's `plan` field with one section per child — title, scope, files, acceptance criteria. The parent plan is the index; each child's own `description` carries the child-specific implementation detail.

4. Set the parent to `status: 'waiting'`. **Do NOT auto-approve** — a human reviews the decomposition before the cascade fires.

5. Post a plan comment summarizing the decomposition decision and rationale: which children, why this split, what the parent's integration test will verify.

**What happens after human approval (automatic):**
- Parent `waiting → approved` fires the cascade: every `on_hold` child flips to `approved` (`manualHold` cleared if set).
- Children run their pipelines in parallel through code → review → test → staging.
- When the LAST child reaches `staging`, the watcher posts a comment on the parent and re-fires the parent's pipeline so `forge-test` runs the integration step on merged children code.
- Parent reaches `released`. The L2 release gate (`waiting_on_decomp_parent`) clears for every child's queued `release` job — children release atomically with the epic.
- Parent → `closed` forces any non-closed children to `closed` (clean-up when the epic is abandoned).

**Verifying sibling-blocks edges took effect (ISS-131 breadcrumb):**
The L2 dispatcher gate evaluates `blocks` parents at dispatch time for EVERY job type (`triage`, `plan`, `code`, `review`, `test`, `fix`, `release`) — not only `release`. When a downstream child's `forge-triage` is queued behind a non-terminal blocker, the child's `agent_sessions` row stays at `status='queued'` with `failure_reason='waiting_on_dep'` and `metadata.waitingOn` listing the blocking parents. If after cascade-approve you observe every child's `forge-triage` dispatching in parallel, the most likely cause is that `forge_pm_set_dependency` never ran or threw silently — go back and re-call it for each declared `blocks` edge.

### Step 6: Post Comment & Set Status

**Simple or Medium complexity:**
```
forge_comments → create → { data: { body: "<plan comment>", issue: "<documentId>", author: "Alakazam" } }
forge_issues → update → { documentId: "<id>", data: { status: "approved" } }
```

**Complex complexity:**
```
forge_comments → create → { data: { body: "<plan comment>", issue: "<documentId>", author: "Alakazam" } }
forge_issues → update → { documentId: "<id>", data: { status: "waiting" } }
```

Set status to `waiting` — Complex issues wait for human review.

### Plan Comment Format

**For normal plans (Simple / Medium / Complex atomic):**

```markdown
**Plan** — <one-line summary of the approach>

**Affected files:** <count> files in <package(s)>
**Status:** <Auto-approved / Awaiting human approval>

The full plan has been written to the issue's plan field.
```

**For decomposed parents (Complex composite — see Step 5.5):**

```markdown
**Decompose** — Split into <N> sub-issues:
- ISS-<id1>: <title>
- ISS-<id2>: <title>
- ISS-<id3>: <title>

**Rationale:** <one-line: why split, what each child owns>
**Dependencies:** <Independent | "ISS-X must merge first">

Children created at `on_hold` with scoped plans. Approve parent (`waiting → approved`) to cascade children to `approved` and start parallel coding.
```

## Output Rules (Save Tokens)

- **Zero narration.** Tool calls are self-documenting.
- **No quoting files.** Don't repeat file contents.
- **One-line status only.** "Plan written, setting approved."
- **Plan goes to the API, not to chat.**
