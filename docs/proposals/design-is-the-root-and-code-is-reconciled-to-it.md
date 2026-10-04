# Design is the root, and code is reconciled to it

**Removed when:** every phase below is checked off on the pilot workflow and on the remaining
forge workflows, and the reconciliation flow runs from the product (observed layer, markers,
decisions) rather than from this page. The run that ticks the last box deletes this file in the
same change. Tracked by ISS-157.

The owner's direction on dev, 2026-10-04: requirements, approved workflow designs and patterns are
the source of truth that Forge now builds; code may be wrong or outdated. Code is drawn onto the
workflows as an observation, marked against the design, decided node by node, and cleaned. A node
that is badly off is deleted and rebuilt to its design, not patched.

## Checklist

### Phase 0 — the root
- [x] Requirements (REQ-n with BCs), approved workflow designs and patterns
      (`docs/conventions/domain-entities.md`, the ADRs, ports and adapters) are named as the root.
      See [Phase 0 — the root list](#phase-0--the-root-list).
- [x] **Patterns are a root, as pattern v2** (ISS-160): `docs/conventions/domain-entities.md` is
      the one build pattern for every core module, REQ-12 revision 3 makes each rule a business
      criterion (BC-8 widened; BC-11 module kinds, BC-12 dependency direction, BC-13 public face,
      BC-14 table ownership, BC-15 no queries in routes, BC-16 one refusal body, BC-17 status
      machines as data, BC-18 one durable outbox, BC-19 read models, BC-20 permission, BC-21 doors,
      BC-22 adapters), and ADR 0008 (module kinds and dependency direction) records why, beside
      ADR 0006 (adapters) and ADR 0007 (permission). A module that breaks a rule is a **Wrong**
      marker, carried like a non-conforming workflow node; `node scripts/check-module-shape.mjs
      --markers <file>` writes those markers as JSON in the shape the pilot's marks file uses
      (`nodes.<module>.{kind, mark, aspects, rewriteDue, evidence}`), for the REQ-17/18 observation
      store to import. It covers the semantic rules, blocking in `pnpm verify` and CI
      against the bulk suppressions in `.forge/module-shape-suppressions.json`; the import rules are `scripts/check-module-boundaries.mjs`'s blocking baseline. See
      [Phase 0 — pattern v2 order](#phase-0--pattern-v2-order).
- [ ] A component-level design of core draws the six kinds, so module boundaries have a design
      root, and system-context's moved evidence and table count are fixed (ISS-171).
- [x] Every workflow names the requirements it serves: every approved design links at least one
      requirement in the product (`requirement_workflows`), read on both the requirement and the
      design. The four proposed onboarding designs link when they are approved.

### Phase 1 — the node model
- [ ] Every node carries a provenance: `planned` (approved design; reads **Upcoming** while no code
      matches it), `observed` (drawn from code, a layer that never overwrites planned), `matched`.
- [ ] The diff derives markers: planned only → **Upcoming**; observed only → **Not in design**;
      both but diverged → **Wrong**.
- [ ] Health markers sit beside them: Outdated, Needs update, Has a problem, Remove/refactor
      proposed — each derived from evidence it names, never a free-typed flag.

### Phase 2 — observe
- [ ] An observer agent reads the code of one workflow and writes its observed layer, citing a file
      and symbol for every node and edge.
  - [x] Pilot observed (file form); product import owed to Phase 1. See
        [Phase 2 — pilot observation](#phase-2--pilot-observation-requirement-to-delivery).

### Phase 3 — decide
- [ ] Every marked node gets keep / rewrite / delete as a decision comment on its design.
- [ ] Past a stated threshold of markers or divergence the default is **Rewrite**: delete the code
      and build the node to the design.
  - [x] Pilot decided: one decision comment on `requirement-to-delivery` (`b6ce21f8`), one line
        per node. Rewrite: `pins`, `agreed`, `req-head`, `build`, `verdict-result`, `impact`
        (chain A) and `breakdown`, `triage`, `fb-case`, `check` (chain B, a separate run). Keep:
        the four event nodes, `ready`, `routed` and `route-result`, drawn as the code has them in
        approved revision r3. REQ-1 and REQ-2 re-pinned to `issue-lifecycle` r3.

### Phase 4 — act
- [ ] Rewrite and delete run as issues broken down from the design and land on dev continuously.
- [ ] Deleted code removes its observed node; a rewritten node is built to the planned shape.

### Phase 5 — close
- [ ] Re-observe: the node reads matched, its markers clear, its requirement's BCs earn verdicts,
      and the change ships in a dev version.

### Order
- [ ] Pilot one workflow end to end (proposed: `requirement-to-delivery`), then the rest.

## Phase 0 — the root list

Read from project forge on dev, 2026-10-04. A link is a `requirement_workflows` row
(`POST /api/projects/:id/requirements/:req/workflows`); the requirement detail lists its designs and
the design reads them back as `requirements`. Every row also answers to
`docs/conventions/domain-entities.md`, pattern v2 (REQ-12 BC-8 and BC-11 to BC-22), so it is not
repeated per row.

| Requirement | Designs it serves (approved revision) | Patterns beyond domain-entities |
|---|---|---|
| REQ-1 job given design + requirement | issue-lifecycle r3, requirement-to-delivery r2 | |
| REQ-2 status says who it waits on | issue-lifecycle r3 | |
| REQ-3 narration apart from conversation | none | gap 2 |
| REQ-4 versioned business intent | requirement-lifecycle r3, requirement-to-delivery r2, issue-lifecycle r3 | |
| REQ-5 in-project contract | requirement-to-delivery r2 | |
| REQ-6 typed verdicts | requirement-to-delivery r2, issue-lifecycle r3 | |
| REQ-7 feedback item | feedback-lifecycle r2, feedback-triage r3, requirement-to-delivery r2 | |
| REQ-8 assistant proposals wait | suggestion-lifecycle r2, feedback-triage r3, requirement-to-delivery r2 | |
| REQ-9 cross-project contract (draft) | none | no BCs yet |
| REQ-10 onboarding | project-onboarding r1 | |
| REQ-11 Development screens | requirement-to-delivery r2, issue-lifecycle r3 | ADR 0001–0005 (Releases) |
| REQ-12 one set of conventions (r3) | none: it is the pattern root itself | domain-entities.md (pattern v2), ADR 0006, ADR 0007, ADR 0008 |
| REQ-13 project's own rules | project-onboarding r1 | |
| REQ-14 Development to prototype (draft) | none | no BCs yet |
| REQ-15 Agents / Runs | agent-run-standing r1 | |
| REQ-16 Automation | automation r1 | |
| REQ-17 step health (draft) | workflow-step-health (proposed, no approved revision) | |

Links added in this pass: REQ-1, REQ-5, REQ-6, REQ-7, REQ-8 to requirement-to-delivery; REQ-4,
REQ-6, REQ-11 to issue-lifecycle; REQ-8 to feedback-triage. The ports-and-adapters ADR (0006) has
landed and sits in REQ-12's pattern column.

**Traceability gaps, owed to Phase 1:**

1. Only REQ-15 and REQ-16 name design steps in their BCs, and every id they name exists in the
   approved revision. No other BC names a step, so a step marker cannot yet reach a BC.
2. REQ-3 is served by no approved design: comment intent and typed events are drawn nowhere.
3. Edges have no id. REQ-15 names edges by label (`silence.passed`, `gate.overdue`,
   `master.declared`), and issue-lifecycle draws the park and drop edges once "from any non-terminal
   status", so the 13 transitions REQ-2 BC-2 lists cannot each carry a marker.
4. REQ-7 BC-2 names `planned` and `resolved` as statuses; feedback-lifecycle r2 draws them as views,
   and draws `reopened`, which the BC does not name.
5. The new links pin nothing: their requirements were agreed before the link, so
   `pinnedRevision` is empty until a person re-pins. REQ-1 and REQ-2 were re-pinned to
   issue-lifecycle r3 in Phase 3, so every issue planned against the r2 baseline reads changed
   since plan until it is re-planned.
6. REQ-9, REQ-14 and REQ-17 are drafts with no BCs.

## Phase 0 — pattern v2 order

The review (2026-10-04) read core against the pattern and found one import cycle over most of it,
tables with no owner, and the same fact computed in several places. The owner froze features the
same day so the kernel goes first. Each rebuild is a draft issue blocked by ISS-160; the edges
below hold the order, and each kernel-first issue says in its description which of the others it
may run beside.

| Order | Issue | Rule | Runs beside |
|---|---|---|---|
| 1 | ISS-159 permission, one `can()` (landed on dev) | BC-20 | table writers, read models |
| 2 | ISS-161 issue, job, run and session machines as data under one kernel transition; the schema imports no domain (landed on dev) | BC-17, BC-12 | nothing: runs alone, blocks 3–5 |
| 3 | ISS-162 one refusal body, codes in contracts | BC-16 | ISS-163, ISS-164 |
| 3 | ISS-163 one owner per table, comments first; the release hold a typed record | BC-14 | ISS-162, ISS-164 |
| 3 | ISS-164 one Standing contract, needs-you in core, web derives nothing | BC-19 | ISS-162, ISS-163 |
| 4 | ISS-166 one durable outbox, dead topics deleted | BC-18 | — |
| 5 | ISS-167 adapters import no domain; ADR 0006 amnesties closed (landed on dev) | BC-22 | — |
| 5 | ISS-168 one route-mount registry, tools in their modules | BC-21 | — |
| 5 | ISS-169 routes hold no queries; REST issue list on the list service | BC-15 | — |
| — | ISS-170 one cron (agents into schedules) (landed on dev) | BC-14 | any |
| — | ISS-171 component design of core (landed on dev) | BC-11, BC-12 | any |
| QA | ISS-165 one "passing" predicate (draft until QA) | BC-19 | — |

Carried by other issues, not filed again: the job-context loader from the baseline pins (ISS-150,
chain A `build`), changed-since-plan computed twice (ISS-152, chain A `impact`), the system graph in
web (ISS-153), the 17-to-10 legacy status map (ISS-174) and the MCP tools the CLI or API replace
(ISS-176) — all landed on dev — and the forge-plugin side of the ten-status model (reported there).

### Pattern divergences carried from pattern v1

Pattern v1 kept these by hand. Pattern v2 states rules only, so each moves here until a rebuild or
a decision clears it; "Absorbed by" names the issue whose rule covers it, else the owner v1 named.

| # | Divergence | Absorbed by |
|---|---|---|
| 4 | Revision states moved to `packages/contracts/src/requirements.ts:REVISION_STATES`, which `packages/core/src/db/schema-requirements.ts` re-exports, but `packages/web-v2/src/features/requirements/types.ts` still redeclares `RevisionState`; the requirement spec and criterion schemas live in `packages/contracts/src/suggestions.ts` rather than in contracts' requirements module; route bodies are built inline (`packages/core/src/requirements/routes.ts:revisionFields`) | review |
| 5 | Criteria verdict values are declared once in `packages/contracts/src/verdict-identity.ts:VERDICT_VALUES`, which core re-exports (`packages/core/src/db/schema-issue-criteria.ts:verdictValues`), and redeclared as a literal union in web (`packages/web-v2/src/features/issues/criteria.ts`). Design statuses moved to `packages/contracts/src/design-status.ts:DESIGN_STATUSES` and agent-report kinds to `packages/contracts/src/agent-reports.ts:AGENT_REPORT_KINDS` (ISS-93), which core re-exports | review |
| 7 | Workflow design state is one head status, not per-revision `REVISION_STATES`; a revision's state is derived on read (`packages/core/src/workflows/design-standing.ts:revisionStateOf`), never stored; `decided_by_user` / `proposed_by_user` naming | review (migration) |
| 8 | `contract_versions.decided_as` says `person` (and carries `before-approval`); `actor_agency` and `author_agency` have no CHECK | review (migration) |
| 9 | Criteria and verdict rows are insert-only by comment, with no trigger | review (migration) |
| 10 | A re-proposal of a returned requirement revision overwrites `proposed_at` / `proposed_by`, with no row per proposal; returns have their own rows (walkthrough D6) | review |
| 14 | An agency check older than the redesign: `packages/core/src/issues/merge-marker.ts:applyMergeMarker` asks an actor whose agency is `agent` for work evidence a person is not asked for | review (still standing after ISS-159) |
| 15 | Body validation outside `strictBody`: criteria and record events use `zValidator` with no shape hint; agent-report triage bodies take `strictBody` since ISS-113 | review |
| 16 | `forge_agent_report` is a singular name; its `submit` inserts through `packages/core/src/agent-reports/service.ts:insertReport` but checks its input inline, and the REST door has no submit | ISS-168 |
| 17 | The ISS-54/55/56 `cm:hack` annotations carry no `ISS-n until:` (`packages/core/src/issues/criteria/event-verdicts.ts`, `packages/core/src/issues/record-events/mirror.ts`, `packages/core/src/issues/record-events/history.ts:legacyCommentRecords`, `packages/core/src/comments/tree.ts:recordOf`) | review |
| 20 | The BA door posts a questionnaire through its bound tool (`packages/core/src/assistant/tools/ba-tools.ts`, `ba_send_questionnaire`) without the `questionnaires.write` permission REST posting takes (`packages/core/src/questionnaires/rules.ts:posterRefusal`); the room binding stands in for it | review (still standing after ISS-159) |
| 21 | The `feedback:*` token grant still means agent reports, so FB-n routes ride `projects:*` (`cm:hack ISS-59` in `packages/core/src/credentials/pat-permissions.ts`) | ISS-168 |
| 22 | Feedback's target arc holds requirement, issue, release and workflow; a screen is `where_seen` text with no key, as the approved design has it, not the arc member REQ-7 BC-1 lists. A release is a `pipeline_runs` row | review |
| 24 | The `answer` route stores its text on `feedback.answer`, not a decision comment; comments gained the feedback arc in ISS-83, and nothing moved the answer onto one | review |
| 25 | Feedback gaps the POC left: an agent's clarification answer is not turned into a triage suggestion; a high or critical item does not wake the master; deleting a reporter's data does not reach text already copied into a filed draft issue; a person on the MCP door is treated as provider-bound; the scrubber recognises an unlabelled name only when it opens with a common Vietnamese surname (`packages/observability/src/personal-data.ts:scrubPersonalData` names the trade-off), so a name with a rarer surname still passes; a clarification answer (written by the questions module) and a triage suggestion's note are stored unscrubbed | review |
| 26 | The conversation detail carries the room's questionnaire batches, and the list each room's `kind` and `threadStatus` (`packages/core/src/assistant/conversation-routes.ts`): a conversation route reading the onboarding and questionnaire rows instead of the client reading `/questionnaires/:bid` | review |
| 28 | `POST /api/projects/:id/onboarding/join` adds the caller to the onboarding room, which can turn a direct room into a group; joining takes `project.write` (`packages/core/src/onboarding/service.ts:joinOnboarding`) | review |
| 31 | The data-flow guard reads the level itself (`packages/core/src/onboarding/read.ts:projectHoldsSensitiveData`) to decide whether a data-flow design is owed, which is not an egress decision | review |
| 37 | Comments (ISS-83): an issue decision stays prose, held only off issues by `comments_decision_fields_chk` (`cm:hack ISS-83` in `packages/core/src/db/schema.ts:comments`); the issue door keeps its untyped `comment.created` activity rows and writes no `comment_events`; `comments` has no `project_id` and no `author_agency` (the agency is read from the device or `users.kind`, as ISS-1137 decided); a comment on another entity is not screened by `packages/core/src/comments/screen.ts:screenAgentComment` and takes no mentions or attachments | ISS-163 |
| 38 | REST and MCP answer different defaults: a REST read is full unless `?view=summary`, an MCP call a summary unless `view: 'full'`; REST writes take no view and answer the whole entity | ISS-168 |
| 40 | Closed: the MCP tools it named (`forge_issues`, `forge_feedback_items`, `forge_knowledge`) are not served since the MCP slimming of 2026-10-04 | ISS-168 |
| 41 | A projection runs after the whole read: a write still reads the full detail (`packages/core/src/requirements/read.ts:detailOf`, `packages/core/src/workflows/design-service.ts:designView`) and the door drops most of it | review |
| 42 | Closed: `forge_suggestions` is not served since the MCP slimming of 2026-10-04; suggestions are `/api/projects/:id/suggestions` | ISS-168 |
| 43 | A master pass has no key: refusals name it by its verb and start time, and its history (`GET /api/projects/:id/masters/passes`) pages by `before`, the last start a page served (`packages/core/src/masters/read.ts:listMasterPasses`), not by a key | review |
| 44 | Agent-report triage (ISS-113) keeps its outcome on the report row (`packages/core/src/db/schema-agent-reports.ts:agentReports`, triage columns): a reopen clears it and a later triage overwrites it, with no row per decision, so a re-triaged report loses who decided before; writes serialise on a row lock (`packages/core/src/agent-reports/service.ts:triageReports`), not an advisory lock; reports migrated by 0368 carry no `triaged_by` | ISS-116 |

## Phase 2 — pilot observation (requirement-to-delivery)

The approved revision r2 (39 steps, 47 edges) read against the code at `8bea1e165` on dev. Four
read-only observer agents split the journey (requirement and agree, breakdown and build, contracts
and release, feedback); every observed step cites a file and symbol, checked to exist. The observed
layer is a workflow-v2 document (`observed-requirement-to-delivery.json`), attached to ISS-120 with
the script that diffs it (`diff_observed.py`) and its output (`marks-requirement-to-delivery.json`).
The files go once REQ-17's observation table lands (REQ-18 decision). The script derives the marks
by REQ-17 BC-22 to BC-25: a planned step with no observed step is Upcoming, an observed step with no
planned step is Not in design, and a step in both that differs is Wrong, naming each differing aspect
(behaviour, data, wiring). A divergent line counts toward the step it feeds. Rewrite is due at two
aspects, three markers, or two problem builds in 30 days. Only the aspect rule can fire today: no
evidence markers exist, and no build traces to a step.

| | Matched | Upcoming | Not in design | Wrong |
|---|---|---|---|---|
| Steps | 10 | 6 | 17 | 23 |
| Edges | 27 | 10 | 0 | 10 |

Matched steps: `forge`, `similar`, `live-issues`, `provider-live`, `approve`, `broken-down`, `publish`,
`contract-result`, `issue-result`, `released`.

**Known-answer check.** The same observer ran blind on `suggestion-lifecycle` r2. It agreed with
the expected answer: `withdrawn` and the `feedback_triage` kind came back as not in design, and every
other state matched. It also marked `accepted` partly wrong (an issue triage or duplicate accept
leaves no `from_suggestion_id`) and three of the four edges wrong. So it is reliable on Upcoming and
Not in design, and stricter than the known answer on lines.

**Workflow-v2 refuses the observed layer on one count:** 50 steps against the 40-step cap. An
observation holds the built steps plus everything the design does not draw, so the Phase 1 store
needs its own cap.

### Marked planned steps and the recommended decision

The decision is the orchestrator's (Phase 3), written as `node:<stepId> — keep|rewrite|delete`.
Upcoming steps are recommended **rewrite**, which here means building the node to the design.

| Step | Mark | Aspects | Code | Recommendation |
|---|---|---|---|---|
| `accept` | Upcoming | — | — | **rewrite**: Nothing writes accepted_at; build it. |
| `accept-result` | Upcoming | — | — | **rewrite**: Build it. |
| `acceptance` | Upcoming | — | — | **rewrite**: Build it. |
| `contract-first` | Upcoming | — | — | **rewrite**: Build it, with obs-contract-wait removed. |
| `delivery` | Upcoming | — | — | **rewrite**: Build the case. |
| `expect-breakdown` | Upcoming | — | — | **rewrite**: Build it. |
| `agreed` | Wrong | behaviour | `requirements/service.ts:agreeRequirement` | **rewrite**: Pin contract versions in the agree transaction, with pins. |
| `breakdown` | Wrong | behaviour, data | `suggestions/propose.ts:proposeIn` | **rewrite** (due): One open breakdown per revision, BC traces required, master as proposer. |
| `build` | Wrong | behaviour, data | `workflows/run-context-service.ts:tracedDesignsOf` | **rewrite** (due): Load the pinned design and contract revisions, not the latest approved and issue-text refs (REQ-1 BC-7, REQ-4 BC-12); delete the second path. |
| `check` | Wrong | behaviour, data | `requirements/standing.ts:coverageOf` | **rewrite** (due): Build the acceptance task with its SLA on the coverage read that exists. |
| `contract-recorded` | Wrong | data | `ecosystem/contract/record.ts:recordVersion` | **keep**: Same as drafted. |
| `delivered` | Wrong | behaviour | `requirements/standing.ts:deliveryOf` | **rewrite**: Write the requirement.delivered notice the acceptance case opens from. |
| `drafted` | Wrong | data | `requirements/service.ts:writeRevision` | **keep**: The row is the record and nothing consumes the event; revise the design to say so (one revision for the four event nodes). |
| `fb-case` | Wrong | behaviour, wiring | `feedback/standing.ts:phaseOf` | **rewrite** (due): Threshold reached; build the case the design draws, or the orchestrator revises the design to make the FB-n row the case. |
| `fb-filed` | Wrong | data | `feedback/service.ts:createFeedback` | **keep**: Same as drafted. |
| `impact` | Wrong | behaviour, data, wiring | `packages/contracts/src/requirements.ts:changedSincePlan` | **rewrite** (due): Differs in behaviour, data and wiring; delete the flag-only code and the second computation, build impact on read with the gate the design draws. |
| `pins` | Wrong | data, wiring | `requirements/baselines.ts:latestBaselineIn` | **rewrite** (due): Contract pins are never written and bindings never read; build the pin set to the design with req-head and agreed. |
| `ready` | Wrong | behaviour | `requirements/rules.ts:agreeRefusals` | **keep**: REQ-4 BC-4 lets any person member sign; revise the design from "BA or owner". |
| `release-gate` | Wrong | behaviour | `release-batch/blockers.ts:rosterBlockers` | **rewrite**: Small: record gate off on the batch. |
| `release-requested` | Wrong | data | `release-batch/service.ts:createReleaseBatch` | **keep**: Same as drafted; also drop environment, a batch is production only. |
| `req-head` | Wrong | data | `requirements/read.ts:detailOf` | **rewrite**: Add the requirement-to-contract link; agreed and pins cannot pin contracts without it (REQ-5). |
| `rollup` | Wrong | behaviour | `requirements/standing.ts:deliveryOf` | **rewrite**: The phase is one TypeScript computation since ISS-164 (view dropped); short-as-pass is left to the passing predicate (ISS-165). |
| `route` | Wrong | wiring | `feedback/triage.ts:triageIn` | **keep**: Its only divergence is that triage and route are one act; settled by the fb-case decision. |
| `route-result` | Wrong | data | `feedback.ts:FEEDBACK_ROUTES` | **keep**: Same revision as routed: take the route values from feedback-triage. |
| `routed` | Wrong | behaviour | `feedback/triage.ts:triageIn` | **keep**: feedback-triage r3 draws decline and answer as the code does; revise this design to reference it. |
| `runs` | Wrong | data | `issues/criteria/verdict-input.ts:VerdictIdentity` | **rewrite**: REQ-6 BC-2 names four identities; storefront_draft and short-as-pass are outside it. |
| `stalled` | Wrong | behaviour | `requirements/standing.ts:turnOf` | **rewrite**: Build the 2-day expectation and its breach on the master pass instead of the instant standing line. |
| `triage` | Wrong | behaviour, data, wiring | `feedback/triage.ts:triageFeedback` | **rewrite** (due): Routes, deadline and requirement_id differ from the rule table; rebuild to it, decline included. |
| `verdict-result` | Wrong | behaviour, data | `issues/criteria-verdicts.ts:currentContracts` | **rewrite** (due): Judge against the pinned version both sides built, with a contract-test verdict. |

### Not in design

| Observed | Code | What it does | Recommendation |
|---|---|---|---|
| `obs-repin` | `requirements/repin.ts:repinRequirement` | A person writes a further baseline of the same head pinning designs approved past their pin (REQUIREMENT_PINS_CURRENT). | **keep**: REQ-4 needs it once a pinned design moves; draw it beside agreed. |
| `obs-defer` | `requirements/deferral.ts:deferRequirement` | Status deferred with insert-only deferral rows and five refusal codes. | **keep**: A person act on the requirement; belongs in requirement-lifecycle, which owes it. |
| `obs-mockup-pins` | `requirements/baselines.ts:acceptedMockupIds` | Accepted mockups are pinned beside designs and given to jobs. | **keep**: ISS-78 is a build of this design; the pins node owes the mockup output. |
| `obs-readiness-mode` | `requirements/rules.ts:baselineReadiness` | Readiness gate off, warn or block (default off), copied onto the baseline. | **keep**: It is the design's "where the project turns it on"; draw the copy onto the baseline. |
| `obs-link-issue` | `requirements/issue-links.ts:linkIssue` | An existing issue links to the requirement and stamps planned_revision. | **keep**: REQ-4 BC-8 and BC-9. |
| `obs-csp-second` | `issues/standing-read.ts:changedSincePlan` | planned < current only, ignoring re-pins; disagrees with packages/contracts/src/requirements.ts:changedSincePlan. | **delete**: Two answers to one question; the impact rewrite owns the only one. |
| `obs-standing` | `requirements/standing.ts:deriveStanding` | Attention groups and whom a requirement waits on (re-pin, prove BC-n, approve breakdown). | **keep**: The read model the stalled, acceptance and re-plan nodes should be served from; draw it. |
| `obs-build-gate` | `workflows/build-gate.ts:assertDesignApprovedForIssue` | An issue linked as a build is held from claim until its design is approved (WORKFLOW_DESIGN_NOT_APPROVED). | **keep**: REQ-1 BC-6; draw it on delivery to build. |
| `obs-link-build` | `suggestions/breakdown.ts:breakdownEffect` | Each breakdown issue is linked as a build of one pinned design (SUGGESTION_BUILD_UNNAMED, SUGGESTION_BUILD_UNPINNED); issues are filed at draft. | **keep**: Traceability step markers need; draw it, and decide whether draft issues wait on a promote. |
| `obs-context-budget` | `workflows/run-context.ts:ARTIFACT_CONTEXT_CAP_CHARS` | 24k design and 12k requirement budgets with named trims (ARTIFACT_CONTEXT_OVER_BUDGET); egress checks the blocks. | **keep**: REQ-1 BC-5. |
| `obs-contract-wait` | `ecosystem/waits/gate.ts:assertWaitsSettledForIssue` (deleted by ISS-214) | An issue waiting on a contract version is held from claim until the provider approves it (CONTRACT_WAIT_UNSETTLED). | **rewrite**: Contradicts the design, which builds both sides in parallel against the generated mock; rebuild with contract-first. |
| `obs-named-contracts` | `ecosystem/contract/named-context.ts:loadNamedContracts` (deleted by ISS-150) | A job gets the contract versions its issue text names, and a link-pin diff (ecosystem/contract/run-context-service.ts:loadContractContext). | **delete**: A second pin path beside the baseline; removed when build loads contract pins. |
| `obs-release-hold` | `release-batch/hold.ts:criteriaHold` | RELEASE_CRITERIA_UNEARNED re-checks verdicts against the serving runtime. | **keep**: Guards released; draw it on release-gate. |
| `obs-contract-approve` | `ecosystem/contract/decide.ts:decideContractVersion` | A recorded version is proposed until approved or returned; breaking needs a person. | **keep**: REQ-5 BC-5 to BC-10; the publish node owes the approval. |
| `obs-breaking-feedback` | `ecosystem/contract/announce.ts:fileBreakingIn` | Approving a breaking version files feedback per consumer with the commitment window. | **keep**: Design files it at record; draw it at approval. |
| `obs-landing-contract` | `ecosystem/contract/drift.ts:landingDriftRefusal` | Marking merged must name the current contract version (CONTRACT_LANDING_UNNAMED, CONTRACT_DRIFT). | **keep**: REQ-5 BC-13. |
| `obs-feedback-acts` | `feedback/service.ts:verifyFeedback` | Verify, reopen, clarify, redact, hard delete, promote from an agent report, the answer route and the screen target. | **keep**: Drawn in feedback-triage, feedback-lifecycle and automation; this design references them rather than redrawing. |

### Top rewrite candidates

1. **`build`**: a job loads each design at its latest approved revision and takes contract versions
   from the issue text, not from the baseline pins that REQ-1 BC-7 and REQ-4 BC-12 name. Two
   context paths answer one question. Delete `obs-named-contracts` with it.
2. **`impact`**: wrong on all three aspects. Changed-since-plan is a flag on the issue read and
   never refuses at awaiting_release, where the design says it does. Nothing lists screens or
   requirements, and a second computation disagrees (`obs-csp-second`, delete).
3. **`pins` with `agreed` and `req-head`**: the pin table has contract columns but no code writes a
   contract pin, because a requirement has no contract link. The contract half of the journey
   (`contract-first`, `verdict-result`, `release-gate`) rests on this.
4. **`verdict-result`**: a contract or design verdict counts against the newest approved version,
   not the one both sides built against.
5. **`breakdown`, `triage`, `fb-case`, `check`**: past the threshold; each differs in behaviour and
   data from its rule table.

Since this observation, chain A has landed on dev: `build` (ISS-150, which deleted
`obs-named-contracts`), `verdict-result` (ISS-151) and `impact` (ISS-152, after which
`issues/standing-read.ts` reads the one `changedSincePlan`, now `packages/contracts/src/requirements.ts:changedSincePlan`). Chain B's
`breakdown` (ISS-154), `triage` and `fb-case` (ISS-155) and `check` (ISS-156) are merged and await
release. None has been re-observed (Phase 5).

**Keep, revise the design:** the four event nodes (the row is the record; nothing consumes an
event), `ready` (REQ-4 BC-4 lets any person member sign), and `routed` / `route-result` (take them
from feedback-triage r3, which draws the code's routes). These revisions go to the approver of
requirement-to-delivery; they change no code.

## Honest costs

| What adopting this costs | The price |
|---|---|
| Old code is thrown away | A node rewritten instead of patched loses whatever its old code handled that the design never stated; that loss is accepted on dev and surfaces as a new marker, not as a guarded regression. |
| Observation is a second model of the code | The observed layer is only as true as the agent that drew it; until re-observation is cheap it goes stale like any document. |
| Markers depend on traceability that is partial today | Step-level links (feedback on a step, BCs naming steps) do not all exist yet, so the first markers are coarser than the design shows. |
