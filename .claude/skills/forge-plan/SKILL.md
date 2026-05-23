---
name: forge-plan
description: "Write implementation plans for confirmed Forge issues. Use this skill whenever an issue needs a plan before coding begins — exploring the codebase, identifying affected files, and writing step-by-step implementation instructions into the issue's plan field. Triggers on: /forge-plan, planning issues, writing implementation plans, exploring codebase for an issue, preparing issues for development, moving issues from confirmed to approved. Also use when the pipeline needs to advance an issue from confirmed status."
user_invocable: true
arguments: "documentId"
---

# Forge Plan

The second step in the issue pipeline: `confirmed → approved`. Turns a triaged issue into a concrete implementation plan a coding agent can follow without re-exploring the codebase.

Planning is the highest-value step in the pipeline. A good plan saves the coding step from wasting tokens on exploration, wrong turns, and rework.

> **English-only**: every byte written to the issue's `plan` field MUST be in English regardless of the issue's source language. See [`../README.md` § English-only rule](../README.md) for the full rule + the ISS-43 incident that motivates it. Translate user wording to English before embedding in the plan.

## Usage

```
/forge-plan <documentId>
```

## Two-tier planning

- **Lightweight (Simple / Medium):** `knowledge.json` + issue description + targeted Glob to identify files; read at most 1-2 source files; focus on **what** (files, changes, approach).
- **Deep (Complex):** full codebase exploration; read all affected files, trace dependencies, verify patterns; be concrete about **what** and **how** (paths, function names, pattern references).

Tier is determined by the triage comment's complexity classification.

## Status transitions (set in Step 6)

| Complexity | Status set | Trigger |
|---|---|---|
| Simple / Medium | `approved` | auto-approved — forge-code dispatches immediately |
| Complex atomic (not decomposed) | `waiting` | human reviews + approves before code starts |
| Complex composite (decomposed) | `waiting` + children at `on_hold` | parent approval cascades all children to `approved` |

## User-facing rule (mandatory)

If a feature is **user-visible** (UI, dashboard, settings page, public API), the plan MUST cover both backend AND frontend slices. A backend-only plan for a user-facing feature is incomplete — factor frontend scope into complexity assessment. If `acceptanceCriteria` mentions "visible in UI", "user can see/do X", or similar, frontend coverage is required.

## Workflow

### Step 1: Fetch issue + triage context

```
forge_issues → get → { documentId: "<id>" }
forge_comments → list → { filters: { issue: "<documentId>" } }
forge_config → get
```

Verify status is `confirmed`. Find the triage comment and extract complexity.

**Checkout latest baseBranch** (resolved via `forge_config`, so issues with a non-default base — decomposed-epic integration branches, hotfix bases — check out the right starting point):

```bash
BASE=$(forge_config get --projectId "$PROJECT_ID" --issueId "$DOCUMENT_ID" \
  | jq -r '.config.branchConfig.baseBranch // .config.baseBranch // "main"')
REMOTE=$(git remote | head -1)
git fetch "$REMOTE" "$BASE"
git checkout "$BASE" && git pull "$REMOTE" "$BASE"
```

The `// .config.baseBranch // "main"` chain is the fallback ladder: PR-A's resolver, then the legacy project default, then the hard default. Same precedence as the resolver itself.

> Background reading for branch resolution: prose in `CLAUDE.md` § Branching strategy at the repo root; structured data in `packages/.forge/knowledge.json → branchStrategy`. Read either when an issue carries a non-default `branchConfig`.

### Step 2: Understand the issue

Read everything: title, description, acceptanceCriteria, suggestedSolution, triage comment, attachments, relations. Synthesize: **what area is affected, what should change, what constraints exist.**

### Step 3: Build the file map

Read `.forge/knowledge.json` to resolve the issue into concrete file paths. Use targeted Glob to confirm.

### Step 4: Explore (depth depends on tier)

- **Simple / Medium**: file list from knowledge.json + Glob is usually enough. Read 1-2 files max.
- **Complex**: read all affected files, trace data flow, check shared dependencies via Grep.

### Step 4.5: Handle relations (only if implementation depends on them)

See [references/relations.md](references/relations.md) for the `blocks` / `decomposes` / `relates` decision matrix and how to add a dependency via `forge_pm_set_dependency`.

### Step 5: Write the plan

```
forge_issues → update → { documentId: "<id>", data: { plan: "<markdown plan>" } }
```

### Step 5.5: Decide whether to decompose (Complex epics only)

For Complex issues with >3 parallel workstreams that each ship independently, split the epic into parent + children. The lifecycle hooks automate cascade approve, all-children-ready watcher, atomic release gating, and close cascade.

Full when-to / how-to / what-happens-after workflow: [references/decomposition.md](references/decomposition.md).

### Step 6: Post comment + set status

Comment format: see [references/comment-formats.md](references/comment-formats.md).

Order matters — comment FIRST, then transition status (the transition triggers the next pipeline step which will read the comment).

| Complexity | After comment posted |
|---|---|
| Simple / Medium | `forge_issues → update → status: "approved"` |
| Complex atomic | `forge_issues → update → status: "waiting"` |
| Complex composite | parent stays at `waiting` (set in decomposition flow); children are at `on_hold` |

## References

- [references/decomposition.md](references/decomposition.md) — Step 5.5 in full: when / when-not, how to create children, integration branch, sibling-blocks, ISS-131 breadcrumb.
- [references/relations.md](references/relations.md) — Step 4.5 in full: dependency kinds, when to write a `## Relations` section, how to add edges.
- [references/comment-formats.md](references/comment-formats.md) — plan comment templates (normal + decomposed parent).
- [../README.md § English-only rule](../README.md) — non-negotiable.
