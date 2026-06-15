# Decompose protocol (mechanics)

Read this when the plan step has decided an issue IS a Complex epic to decompose
(the decision criteria live in the skill body, Step 5.5). This file is the HOW.

## How to decompose

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

## What happens after human approval (automatic, all system-owned)

- Parent enters `approved` → the cascade flips every `draft` child → `approved` simultaneously.
- Children run their pipelines in parallel through code → review → test → released → closed. Children do NOT wait for the parent.
- The parent sits at `approved` but its forward jobs (code/review/test/fix) are held by the `decomposeChildrenPending` dispatch gate until EVERY child has landed on the base branch (`child.merged_at` set, i.e. child reached `closed`).
- Once all children are merged, the gate clears and the parent runs its integration work LAST (code → … → released → closed). The parent merges after its children.
- Parent → `closed` forces any non-closed children to `closed` (clean-up when the epic is abandoned).

## Verifying sibling-blocks edges took effect (ISS-131 breadcrumb)

The L2 dispatcher gate evaluates `blocks` parents at dispatch time for every job type (not just `release`). When a downstream child's `forge-triage` job is queued behind a non-terminal blocker, the child's `agent_sessions` row stays at `status='queued'` with `failure_reason='waiting_on_dep'` and `metadata.waitingOn` listing the blocking parents. If after cascade-approve you see every child's `forge-triage` immediately dispatch in parallel, the most likely cause is that `forge_project_pm (set_dependency)` never ran or threw silently — go back and re-call it for each declared blocks edge.
