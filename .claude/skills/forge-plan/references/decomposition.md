# Decomposition (Complex epics only) — forge-plan Step 5.5

For Complex issues with **>3 parallel workstreams** that each ship independently, split the epic into a parent + children using `kind='decomposes'` dependency edges. The lifecycle hooks in `pipeline/decomposition-subscribers.ts` automate cascade approve, the all-children-ready watcher, atomic release gating, and close cascade.

## When to decompose

- Each child must be reviewable + testable independently.
- Cap at 6-8 children per epic — worker reliability degrades beyond that.
- The parent must have a meaningful integration-test step after all children land (otherwise just use `blocks` dependencies — the watcher exists specifically to re-fire integration tests on the parent).
- Workstreams should not share critical code paths that will collide at PR-merge time.

## When NOT to decompose

- Single-file changes, refactors localized to one module, bug fixes.
- Items where one child's failure should not block siblings' release — the gate is atomic by design.
- Nested decomposition (epic → epic → story). Single-level only for v1.

## How to decompose

### 1. Create each child issue

```
forge_issues → create → {
  data: {
    title: "<child slice title>",
    description: "<scoped description>",
    status: "on_hold",
    priority: <inherit>,
    category: <inherit>,
    manualHold: false
  }
}
```

Children land at `on_hold` so the orchestrator does NOT auto-dispatch forge-triage. The cascade-approve hook on parent `waiting → approved` flips them to `approved` and the normal pipeline resumes. Do NOT use `manualHold: true` for parking — see [[feedback_manualhold_trap]].

### 2. Add `decomposes` edges

For each created child, add a `decomposes` dependency edge with the parent as the `from` side:

```
forge_pm_set_dependency → {
  projectId: "<projectId>",
  fromIssueId: "<parentId>",
  toIssueId:   "<childId>",
  kind: "decomposes"
}
```

`projectId` is the one from `forge_config → get` in Step 1. The tool is idempotent and returns `{ id, created: true|false }`.

**Integration branch (PR-D, ISS-138):** the first `decomposes` edge on a parent automatically triggers integration-branch creation in core (`packages/core/src/issues/decompose.ts`). Agents do NOT call any git tool — just chain `forge_pm_set_dependency` calls per child. To OPT OUT (e.g. for a decomposition that should branch off project trunk individually), pass `decomposeOpts: { useIntegrationBranch: false }` on the FIRST `forge_pm_set_dependency` call only; subsequent calls inherit the parent's metadata flag.

**When NOT to use the integration branch:** cross-package epics, core refactors, single-sub "decompositions" (just use `blocks` instead), and quick-fix bundles. Full when/when-not list + lifecycle gotchas: `packages/.forge/knowledge.json → recipes.decomposition-integration-branch` and `CLAUDE.md § Branching strategy → Decomposition + integration branch`.

### 3. Add sibling-blocks edges (if parent plan declares ordering)

If the parent's plan declares sibling-blocks ordering (e.g., Sub 2 must wait for Sub 1's pipeline to finish before its `forge-triage` dispatches), add those edges immediately after creating all children:

```
forge_pm_set_dependency → {
  projectId: "<projectId>",
  fromIssueId: "<sub1Id>",    // ships FIRST
  toIssueId:   "<sub2Id>",    // WAITS
  kind: "blocks"
}
```

Verify each call returns `{ id, created: true|false }`. If any throws `FORBIDDEN` or `CYCLE_DETECTED`, stop and post a comment. **Silently writing "Added blocks edges" in the plan text without the rows landing is the failure mode that caused ISS-131.** Never claim a dependency in plan prose unless the MCP call succeeded.

### 4. Write the parent's `plan` field

One section per child — title, scope, files, acceptance criteria. The parent plan is the index; each child's own `description` carries the child-specific implementation detail.

### 5. Set parent to `waiting`

**Do NOT auto-approve** — a human reviews the decomposition before the cascade fires.

### 6. Post the decomposition comment

Summarize the decision and rationale: which children, why this split, what the parent's integration test will verify. Format below.

## What happens after human approval (automatic)

- Parent `waiting → approved` fires the cascade: every `on_hold` child flips to `approved` (`manualHold` cleared if set).
- Children run their pipelines in parallel through code → review → test → staging.
- When the LAST child reaches `staging`, the watcher posts a comment on the parent and re-fires the parent's pipeline so `forge-test` runs the integration step on merged children code.
- Parent reaches `released`. The L2 release gate (`waiting_on_decomp_parent`) clears for every child's queued `release` job — children release atomically with the epic.
- Parent → `closed` forces any non-closed children to `closed` (clean-up when the epic is abandoned).

## Verifying sibling-blocks edges took effect (ISS-131 breadcrumb)

The L2 dispatcher gate evaluates `blocks` parents at dispatch time for EVERY job type (`triage`, `plan`, `code`, `review`, `test`, `fix`, `release`) — not only `release`. When a downstream child's `forge-triage` is queued behind a non-terminal blocker, the child's `agent_sessions` row stays at `status='queued'` with `failure_reason='waiting_on_dep'` and `metadata.waitingOn` listing the blocking parents.

If after cascade-approve you observe every child's `forge-triage` dispatching in parallel, the most likely cause is that `forge_pm_set_dependency` never ran or threw silently — go back and re-call it for each declared `blocks` edge.

## Comment format for decomposed parent

```markdown
**Decompose** — Split into <N> sub-issues:
- ISS-<id1>: <title>
- ISS-<id2>: <title>
- ISS-<id3>: <title>

**Rationale:** <one-line: why split, what each child owns>
**Dependencies:** <Independent | "ISS-X must merge first">

Children created at `on_hold` with scoped plans. Approve parent (`waiting → approved`) to cascade children to `approved` and start parallel coding.
```
