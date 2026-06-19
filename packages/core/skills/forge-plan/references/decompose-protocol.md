# Decompose protocol (mechanics)

Read this when the plan step has decided an issue IS a Complex epic to decompose
(the decision criteria live in the skill body, Step 5.5). This file is the HOW.

## The model: one shared integration branch, parent owns the merge to base

Forge decomposes onto a **shared integration branch** (core ISS-138). The mental model:

```
<baseBranch> ◀── feature/ISS-<parent>   (integration branch — ONE per epic, core-created)
                      ├── ISS-<childA>   branches off integration → merges back into it
                      ├── ISS-<childB>   branches off integration → merges back into it
                      └── ISS-<childC>   branches off integration → merges back into it
   ▲                                                                         │
   └──── ONLY the parent squash-merges feature/ISS-<parent> → <baseBranch> ──┘  (once, at the end)
```

- Children branch **off the integration branch** and merge **back into it** — they NEVER merge to `<baseBranch>` directly. The base branch only ever sees the fully-assembled, parent-verified epic.
- The **parent owns integration**: after every child has landed on the integration branch, the parent runs the integration test on that branch and is the **only** issue that squash-merges it to `<baseBranch>`.
- This is why there is no "is child X an ancestor of base?" check anywhere — children land on a branch the parent controls, and the parent verifies that one branch. (Guessing at base-branch ancestry while a child's merge was still propagating is exactly the ISS-144 false-negative; this model removes the guess.)

**Core does the heavy lifting for you.** When you add the FIRST `decomposes` edge to a parent, core (`decomposeParent`, default `useIntegrationBranch: true`) atomically, in one transaction:
1. creates + pushes the shared integration branch off `<baseBranch>` on the project remote (you do NOT create this branch — core has the git remote, the skill does not);
2. parks the parent at `status: 'waiting'` (the human review gate);
3. leaves any children you created at `draft` (the inert proposal state — no `STATUS_TO_JOB_TYPE` entry, so the orchestrator never auto-dispatches them);
4. stamps `branchConfig` metadata on the parent and every child so the branch resolver hands each child the integration branch as its base+target.

Your job is only to create the child rows, add the edges, and write the index plan. Do not create branches, do not set the parent status, do not stamp `branchConfig` — core owns all of that.

## How to decompose

1. For each child workstream, create a child issue **at `draft`**:
   ```
   forge_issues → create → { data: { title: "<child slice title>", description: "<scoped description>", status: "draft", priority: <inherit>, category: <inherit> } }
   ```
   `draft` is the inert proposal state: the orchestrator does NOT auto-dispatch forge-triage. The cascade-approve hook on parent `waiting → approved` flips every parked child to `approved` and the normal pipeline resumes. (Do not use `on_hold` — `draft` is the canonical parked state core itself uses; the cascade accepts both only for backward compatibility.)

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

   **The FIRST decomposes edge triggers integration-branch creation + `branchConfig` auto-fill on the parent and child** (core, default on). You do not pass any branch option — leave `useIntegrationBranch` at its default. Only pass `decomposeOpts.useIntegrationBranch: false` if this epic genuinely should NOT share a branch (rare — e.g. children touch entirely disjoint repos); then children branch off the project default and the parent has nothing to integrate.

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
   Verify each call returns `{ id, created: true|false }`. If a call throws `FORBIDDEN` or `CYCLE_DETECTED`, stop and post a comment — silently writing "Added blocks edges" in the plan text without the rows landing is the failure mode that caused ISS-131. Never claim a dependency in prose unless the MCP call succeeded.

3. Write the parent's `plan` field with one section per child — title, scope, files, acceptance criteria — PLUS a **parent integration step** section describing the end-to-end check the parent will run on the integration branch after all children land. The parent plan is the index; each child's own `description` carries the child-specific implementation detail.

4. Do **NOT** set the parent's status yourself. Core's `decomposeParent` already parked it at `waiting`. Manually overriding the parent status is the drift that breaks the kickoff. A human reviews the decomposition before approving.

5. Post a plan comment summarizing the decomposition decision and rationale: which children, why this split, what the parent's integration test on the integration branch will verify.

## What happens after human approval (automatic, all system-owned)

- Parent enters `approved` → the cascade flips every parked (`draft`) child → `approved` simultaneously.
- Children run their pipelines in parallel (or serially, if sibling-`blocks` ordering was set) through code → review → test → released → closed. **Each child branches off the integration branch and merges back into it** (the branch resolver returns the integration branch as the child's base+target from the stamped `branchConfig` — forge-code/forge-test read it, they do not hardcode `<baseBranch>`). A child's `merged_at` is stamped when it lands on the **integration branch** (forge-test calls `mark_merged` with `target: 'feature'`), NOT when it touches base.
- The parent sits at `approved` but its forward jobs (code/review/test/fix) are held by the `decomposeChildrenPending` dispatch gate until EVERY child has `merged_at` set (i.e. landed on the integration branch) or is `closed`.
- Once all children have landed, the gate clears and the parent runs **last**: it verifies the integration branch (the fully-assembled epic) end-to-end, then — and only then — squash-merges `feature/ISS-<parent>` → `<baseBranch>` ONE time (forge-test, `mark_merged` with `target: 'base'`), deploys, and closes. The parent is the single point that reaches base/production.
- Parent → `closed` forces any non-closed children to `closed` and deletes the integration branch (clean-up).

## Verifying sibling-blocks edges took effect (ISS-131 breadcrumb)

The L2 dispatcher gate evaluates `blocks` parents at dispatch time for every job type (not just `release`). When a downstream child's `forge-triage` job is queued behind a non-terminal blocker, the child's `agent_sessions` row stays at `status='queued'` with `failure_reason='waiting_on_dep'` and `metadata.waitingOn` listing the blocking parents. If after cascade-approve you see every child's `forge-triage` immediately dispatch in parallel, the most likely cause is that `forge_project_pm (set_dependency)` never ran or threw silently — go back and re-call it for each declared blocks edge.
