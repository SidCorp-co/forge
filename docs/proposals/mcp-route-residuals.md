# Where an MCP tool and its route are still two implementations, and which of them is kept on purpose

ISS-1372 made the MCP tool layer a wrapper: no file under `packages/core/src/mcp/` reaches a table
or a database handle, and the relations gate fails naming the file that does. It also closed the
divergences where one rule had two answers and nothing recorded a reason: who may stamp a feedback
report reviewed, who may edit a comment and under which parent it may hang, who may deploy a Coolify
binding, which project a step-handoff write is made against, and which issue a phase is filed under.
Each of those has a suite that drives both doors through the same cases
(`packages/core/tests/integration/feedback-review-role-e2e.test.ts`, `comment-door-parity-e2e.test.ts`,
`coolify-write-role-e2e.test.ts`, `handoff-door-parity-e2e.test.ts`).

What follows is what that change found and did not close. Every seam below is a read of the source at
`bc4f3c5f7`, found by three read-only audits of the tool files against their routes, and none of
them was run; the five above were.

## Kept on purpose, with the evidence that it was meant

**`forge_issues` update emits no `issueUpdated`.** REST `PATCH /api/issues/:id`
(`packages/core/src/issues/routes.ts:issueRoutes`) emits it, and with it an `issue.updated` activity
row, a room broadcast and a re-index of the issue's text; `packages/core/src/mcp/tools/forge-issues.ts:forgeIssuesTool`
does not. `packages/core/src/issues/update-service.test.ts` says MCP's update deliberately does not,
and the comment above `collectIssueFieldUpdates` in `packages/core/src/issues/patch-fields.ts` read
"known intentional drift (do NOT fix casually)" until the codemap annotations were deleted in
`c74d9b3f7`. No reason was written down. The likely one is that a `sessionContext` write is how a run
renews its lease and writes its worklog, through this same action, so emitting would turn every
renewal into an activity row. What would revisit it: an owner who wants an agent's edit of a title,
description, priority, category or complexity in the feed, emitting for those fields and never for
`sessionContext`.

**`forge_issues` transition passes no `reason` option.** REST passes the caller's reason as both
`reason` and `transitionReason` (`packages/core/src/issues/transition.ts:transitionRoutes`); the tool
passes `transitionReason` only (`packages/core/src/mcp/tools/forge-issues-transition.ts:transitionByData`).
`reason` is the `pipeline.reason` sentinel that lets a non-user actor leave `on_hold` past the
ISS-411 hard stop (`ApplyStatusTransitionOptions` in `packages/core/src/issues/apply-transition.ts`),
so an agent's free text must not reach it. The cost is that an agent's transition shows no reason on
the `issue.statusChanged` broadcast. What would revisit it: splitting the sentinel from the human
reason into two options.

**The `admin` token scope is asked for by MCP only.** `assertPrincipalIsAdmin` in
`packages/core/src/mcp/tools/lib.ts` wants it for archive, skills and config writes; the REST routes
for the same actions ask for the project role alone. It is token fencing, which is not a transport
rule, and the role check is the same on both sides.

**The actor an agent credential writes under.** `principalHookActor` in
`packages/core/src/mcp/tools/lib.ts` records a `device` actor keyed on the token for an agent;
`restActor` in `packages/core/src/middleware/auth.ts` records the user. ISS-932 decided it.

**`forge_project_pm` `dispatch` and `write_decision` refuse by design.** Neither reaches a database;
`dispatchPmJob` says the staged lane is gone and `assertPmActor` says no device authenticates `/mcp`.
They are dead actions rather than divergences, and removing them changes an error a stale skill body
reads, so they stay until none does.

## A tool and a route disagree, and which side is right is the owner's to say

Each line is accepted by one door and refused, or answered differently, by the other.

- Transition reason bound: `forge_issues` takes 10,000 trimmed characters and falls back to `note`,
  REST's `transitionBodySchema` takes 2,000. A 5,000-character reason moves an issue through the
  tool and is a 400 over REST.
- `mark_merged`: the tool takes `target` from `feature`, `base`, `prod`, a free-form `mergedAt` and a
  10,000-character note; `mergeMarkerBodySchema` in `packages/core/src/issues/merge-routes.ts` takes
  any trimmed target up to 200, an ISO `mergedAt` and a 2,000-character note.
- Mentions: REST create parses `@handle`, writes `comment_mentions` and emits `commentMentioned`
  (`packages/core/src/comments/routes.ts`); `forge_comments` create does not, and neither does it
  emit `commentUpdated` on an edit. An agent comment that quotes `@types/node` would notify a member
  named `types`, which is a plausible reason and not a recorded one.
- Pipeline config write: `forge_config` asks for a project admin; the REST route asks for an org admin
  (`assertOrgRoleOnProject` in `packages/core/src/projects/settings-write-routes.ts`) and answers 404
  while the `pipelineControl` flag is off, which the tool does not read. The tool is the looser side.
- `forge_projects` update emits no `contractInputChanged`, and create does not run the release-chain
  gap check that update and REST PATCH run.
- `forge_skills`: a file path may be 1,024 characters over the tool and 500 over REST, and the
  tool does not map `SkillContentBlockedError`.
- `forge_schedules` accepts `prompt` and `script` kinds only and applies no cross-field refinement;
  the REST schemas also take `release_batch` and `sentry_pull` and refuse a body with no fields.
- `forge_runners` register skips the adapter's `validateConfig` and publishes no `runner.created`;
  `retire` and `restore` write `mcp_retire` and `mcp_restore` where the REST `exclude` and `include`
  write `operator_exclude` and `operator_include`, and `retire` refuses a busy runner while `exclude`
  does not.
- `forge_jobs` cancel refuses a platform admin who holds no project role; the REST cancel admits one.
- Memory: the REST routes are rate limited and tag a search `web`; the tool is neither and tags
  `agent`, which changes rerank eligibility. A feedback verdict on a missing row is a 404 over REST
  and a 200 body from the tool.
- `forge_knowledge` does not trim a search query, validates a slug as any 512 characters where REST
  refuses a non-kebab one, and cannot set `readWhen`.
- `forge_metrics` takes `step` from `jobTypes`; REST takes any string up to 64.
- `forge_coolify_deploy` checks `assertAgentMayDeployCoolify` for cancel and rollback; the REST routes
  do not, and take bounded identifiers where the tool takes bare strings.
- `forge_release_batch` records the finishing actor as a device for an agent token where REST records
  the user, and asks for the `write` scope to read.
- `forge_reconcile` `record_verdict` writes the actor `agent:master` whoever calls it.
- `forge_phase` `resume_point` needs the writer role where the REST read needs a viewer, and the tool
  has no `list_phases`.
- `forge_step_handoff` get takes an issue uuid only; the REST list also takes a display key.
- `pm` runner load answers `{ runners }` from the tool and a bare array from REST.

## One capability, two queries, because the two answers are shaped for different readers

The tool calls a service in its domain directory and the route holds a query of its own:
the issue list (`listIssueRows` in `packages/core/src/issues/list-service.ts` against the inline query
in `issueProjectRoutes`), the job list, the pipeline-run list and get, the runner list, and the skill
list, get and sync status. The REST answers page by offset with a total for a screen and the tools
answer with an envelope for a model, so merging each pair is a decision about the REST shape first.

## Capabilities that exist only as a tool

Agent-native, so the tool is the door by the owner's decision: `forge_step_start`'s composite bundle,
`forge_reconcile` verdict and vote, `forge_feedback` submit (it resolves the caller's active job),
`forge_uploads`.

A route is owed to each of these, none of which this change built because each is new API surface
that needs a permission-surface row and an owner's choice of shape: the issue list's `search`, `label`,
`module`, `statusNot`, date and `complexity` filters; `forge_feedback` get and the bulk review by
signal key; `forge_runners` retire, restore and capability validation; `forge_skills` `effective`,
`installOnly` and the dedup list; `forge_skill_facts` get; `forge_coolify_deploy` logs; and the
queued-job `gate` and `gateReason` fields on `forge_jobs`.

No tool was removed. No forge CLI verb covers any of the above, and the CLI is reached by issue in
forge-plugin.

## Honest costs

The price of closing these, not of leaving them:

| Cost | What it takes |
|---|---|
| Each kept drift needs a reason written where the code is | The two kept on purpose carry no comment since the codemap annotations were deleted, so the next reader meets a divergence with nothing saying it was meant. Writing the reason into the code is cheap; finding the person who made the choice is not. |
| Choosing a side changes a contract a caller may rely on | Tightening the tool's transition reason to 2,000 characters refuses a caller that sends more, and loosening REST accepts what it refused. Neither side can move without someone checking which callers sit beyond the bound. |
| A route per tool-only capability is surface to keep | Each needs a row in the PAT permission surface, a test and a shape both transports agree on; seven routes is seven shapes the web and the CLI may then depend on. |
| Merging a pair of list queries is a REST redesign | The paging, the total and the filters a screen uses are not the envelope a model reads, so one query serving both either gives a screen a cursor or gives a model a total it must page for. |
| Nothing here has been run | Every line above the five suites is a read of the source, and an audit that was wrong about one would send the next run to fix something that is not broken. |
