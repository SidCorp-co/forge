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
`docs/conventions/domain-entities.md` (REQ-12 BC-8), so it is not repeated per row.

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
| REQ-12 one set of conventions | none: it is the pattern root itself | domain-entities.md |
| REQ-13 project's own rules | project-onboarding r1 | |
| REQ-14 Development to prototype (draft) | none | no BCs yet |
| REQ-15 Agents / Runs | agent-run-standing r1 | |
| REQ-16 Automation | automation r1 | |
| REQ-17 step health (draft) | workflow-step-health (proposed, no approved revision) | |

Links added in this pass: REQ-1, REQ-5, REQ-6, REQ-7, REQ-8 to requirement-to-delivery; REQ-4,
REQ-6, REQ-11 to issue-lifecycle; REQ-8 to feedback-triage. The ports-and-adapters ADR is not on dev
yet; it joins the pattern column when it lands.

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
| `delivered` | Wrong | behaviour | `requirements/read.ts:deliveryOf` | **rewrite**: Write the requirement.delivered notice the acceptance case opens from. |
| `drafted` | Wrong | data | `requirements/service.ts:writeRevision` | **keep**: The row is the record and nothing consumes the event; revise the design to say so (one revision for the four event nodes). |
| `fb-case` | Wrong | behaviour, wiring | `feedback/rules.ts:phaseOf` | **rewrite** (due): Threshold reached; build the case the design draws, or the orchestrator revises the design to make the FB-n row the case. |
| `fb-filed` | Wrong | data | `feedback/service.ts:createFeedback` | **keep**: Same as drafted. |
| `impact` | Wrong | behaviour, data, wiring | `requirements/rules.ts:changedSincePlan` | **rewrite** (due): Differs in behaviour, data and wiring; delete the flag-only code and the second computation, build impact on read with the gate the design draws. |
| `pins` | Wrong | data, wiring | `requirements/baselines.ts:latestBaselineIn` | **rewrite** (due): Contract pins are never written and bindings never read; build the pin set to the design with req-head and agreed. |
| `ready` | Wrong | behaviour | `requirements/rules.ts:agreeRefusals` | **keep**: REQ-4 BC-4 lets any person member sign; revise the design from "BA or owner". |
| `release-gate` | Wrong | behaviour | `release-batch/blockers.ts:rosterBlockers` | **rewrite**: Small: record gate off on the batch. |
| `release-requested` | Wrong | data | `release-batch/service.ts:createReleaseBatch` | **keep**: Same as drafted; also drop environment, a batch is production only. |
| `req-head` | Wrong | data | `requirements/read.ts:detailOf` | **rewrite**: Add the requirement-to-contract link; agreed and pins cannot pin contracts without it (REQ-5). |
| `rollup` | Wrong | behaviour | `requirements/standing.ts:provenPhase` | **rewrite**: One phase computation: the view, not the view plus TypeScript; decide short. |
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
| `obs-csp-second` | `issues/standing-read.ts:changedSincePlan` | planned < current only, ignoring re-pins; disagrees with requirements/rules.ts:changedSincePlan. | **delete**: Two answers to one question; the impact rewrite owns the only one. |
| `obs-standing` | `requirements/standing.ts:deriveStanding` | Attention groups and whom a requirement waits on (re-pin, prove BC-n, approve breakdown). | **keep**: The read model the stalled, acceptance and re-plan nodes should be served from; draw it. |
| `obs-build-gate` | `workflows/build-gate.ts:assertDesignApprovedForIssue` | An issue linked as a build is held from claim until its design is approved (WORKFLOW_DESIGN_NOT_APPROVED). | **keep**: REQ-1 BC-6; draw it on delivery to build. |
| `obs-link-build` | `suggestions/breakdown.ts:breakdownEffect` | Each breakdown issue is linked as a build of one pinned design (SUGGESTION_BUILD_UNNAMED, SUGGESTION_BUILD_UNPINNED); issues are filed at draft. | **keep**: Traceability step markers need; draw it, and decide whether draft issues wait on a promote. |
| `obs-context-budget` | `workflows/run-context.ts:ARTIFACT_CONTEXT_CAP_CHARS` | 24k design and 12k requirement budgets with named trims (ARTIFACT_CONTEXT_OVER_BUDGET); egress checks the blocks. | **keep**: REQ-1 BC-5. |
| `obs-contract-wait` | `ecosystem/waits/gate.ts:assertWaitsSettledForIssue` | An issue waiting on a contract version is held from claim until the provider approves it (CONTRACT_WAIT_UNSETTLED). | **rewrite**: Contradicts the design, which builds both sides in parallel against the generated mock; rebuild with contract-first. |
| `obs-named-contracts` | `ecosystem/contract/named-context.ts:loadNamedContracts` | A job gets the contract versions its issue text names, and a link-pin diff (ecosystem/contract/run-context-service.ts:loadContractContext). | **delete**: A second pin path beside the baseline; removed when build loads contract pins. |
| `obs-release-hold` | `pipeline/release-hold.ts:criteriaHold` | RELEASE_CRITERIA_UNEARNED re-checks verdicts against the serving runtime. | **keep**: Guards released; draw it on release-gate. |
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
