# The steward: an agent at every Product and Delivery handoff

**Removed when:** the two build lanes at the end of this file have landed and REQ-48's twelve
criteria hold a counting verdict. After that, what holds is the code, `packages/contracts/src/steward.ts`
and the workflow designs listed in section 9.

Requirement REQ-48 r1, BC-1..12. The owner said, 2026-10-21: "agents should intervene between
Product and Delivery to analyse, report clearly per case, check and ask for rework or more ... put
agents into as much as possible so people do not have to look at many things".

Owner rules this design keeps:
- Forge gives agents tools and the agents act. Core never decides.
- Gate as little as possible.
- Pages are properties plus short rows.
- A refusal names what was wrong.
- No provider key: models go only through the gateway.

The shared contract is already landed: `packages/contracts/src/steward.ts`. Both lanes build against
it.

## What was wrong on 2026-10-21, and where in the code

| Seen on dev | Cause in code |
|---|---|
| REQ-45 waits on "Master · take ISS-498" (reopen since 10-14) and REQ-36 on ISS-475 (open since 10-14). Both are grouped Moving, and no master serves the project. | `requirements/standing-work.ts:workTurn` rule 4 puts any open or reopen issue under `moving` / "Master takes next". It reads neither the issue's own standing (`issues/standing.ts` already reads reopen as stuck) nor whether a master serves. `runnerBound` is true because a runner is bound. The 21-day rule (`requirements/standing.ts:STUCK_AFTER_DAYS`) never fires, because issue writes keep touching the item. |
| FB-74 (routed to the draft ISS-284) reads four ways. | **Phase Planned:** `feedback/standing.ts:phaseOf` counted a draft carrier as planned; it now reads triaged and waits on the project's master (`feedback/standing-carrier.ts:draftCarrierWait`). **Banner "ISS-284: ship":** `issueWait` never reads the carrier's standing. **Body "You to take on or drop":** `forecast/feedback-progress.ts:estimateOf` does read the carrier's standing. **Dashboard "Waiting on a person":** `forecast/late.ts:lateWaiting` reads `forecast/facts.ts:waitOf`. |
| FB-89 is declined but shows on At risk. | `forecast/feedback.ts:feedbackLinesOver` never reads the phase, and `feedback/service.ts:declineIn` keeps the route. |
| Dashboard shows "Needs you: Nothing" while the requirement list shows Needs you 1. | The Dashboard counts `needs-you-decisions.ts:classify` decisions. The list counts its own `needs_you` group. `project-status/read.ts:waitsOf` gives a third count. |
| The chat report shows 6 tables, with stuck items last as unlinked text. | `project-status/read.ts` key order and `status-reports/digest.ts:digestText`. There is no stuck section and no Needs you section. |
| The design `turn` rule (r17) | It only says "no owner or untouched 21 days → stuck". |

## 1. Standing contract (BC-8, BC-9)

**There is one read model, not a second path.** The three per-slice derivations stay as they are:
- `requirements/standing.ts:deriveStanding`
- `feedback/standing.ts:feedbackStandingOf`
- `issues/standing.ts:deriveIssueStanding`

Each slice's standing gains `StandingTimes` (`steward.ts`), so `RequirementStanding`, the feedback
view and `IssueStanding` carry the same new fields. The project-wide read
`GET /api/projects/:id/standings` returns `ItemStanding[]`, one row per open item, built from those
same functions. The `forge_standing` tool and the lane B sweep read it through `OpenStandingsRead`.

| Field | Meaning | Built from |
|---|---|---|
| `group` | The slice's attention group. It is `stuck` exactly when `stuck` is set, except for needs_you, done and deferred. | Existing `attentionGroup`. |
| `waitingOn` | Who, act, rule, ref and `says`. | Existing `contracts/standing.ts:WaitingOn`. |
| `actClass` | Which default due applies. | Read off the wait's `says.act.key`, with one table per slice. |
| `since` | When this wait began. | The record's own times: the status move of the item or its carrier (`requirements/standing-facts.ts:statusSinceOf`, `issueTimesOf`), the question's `askedAt`, the release's landing. Never `updatedAt`. |
| `dueAt` | The wait's own due (an SLA task, a snooze, the verify window), else `since + STANDING_DUE_WORKING_DAYS[actClass]` (`lib/working-days.ts:addWorkingDays`). | |
| `stuck` | `{code, since, reason (in BA words), via, says}`, or null. | The stuck rule below. |
| `carriedBy` | The issue the wait was rolled up from. | The roll-up below. |
| `basis` | `standingBasisOf(group, waitingKind, who, actKey, ref, stuckCode, dueAt, carriedBy)`, always taken from the read with no viewer (no `needs_you`, no `you`). | What a note is vetted against. Every viewer compares the same basis. |

### Stuck rule, first that holds wins (replaces r17 `turn`'s "no owner or untouched 21 days")

It is applied to a requirement, a feedback item or an issue whose group is not needs_you, done or
deferred. `needs_you` is exempt because the person is told; it can still be overdue (see Needs you).

| Code | Holds when | Threshold |
|---|---|---|
| `no_owner` | A requirement has no owner. | Immediately (kept from r17). |
| `nobody_serves` | The wait is on the master and `GET …/masters/standing` reads `none`, or `silent` (`contracts/master-standing.ts:MASTER_STATES`). Or the wait is a permission nobody holds (`standing.ts:nobodyHoldsAct`, today's `kind: none` rows). Or the named person is not a member. | Immediately. |
| `draft_carrier` | Feedback routed to an issue at `draft`. Or a requirement whose only unshipped live issues are drafts. | Immediately. Nothing opens a draft by itself (issue-lifecycle `draft`). |
| `overdue` | `now > dueAt`. | Working days from `since`: `master_take` 1, `master_plan` 2 (= `BREAKDOWN_SLA_WORKING_DAYS`), `person_decide` 2, `ba_check` 5 (= `CHECK_SLA_WORKING_DAYS`), `release_cut` 2, `judge` 1, `other` 10. `run` and `reporter` never fall due here: a run is judged by `runs/standing-stuck.ts`, and a reporter by `feedback.verifyWindowDays`. |

These are deleted:
- `STUCK_AFTER_DAYS = 21`
- the web's inference "stuck + kind none ⇒ no owner" (`standing-bits.tsx:RequirementBanner`), which now reads `stuck.code`
- `mcp/requirement-views.ts:standingWaits` `late: t.overdue`, which `stuck.code === 'overdue'` replaces

### Roll-up

| From → to | Rule |
|---|---|
| issue → requirement | This replaces `standing-work.ts:workTurn` rules 1, 3 and 4, and `parkedTurn` becomes its special case. The requirement reads every unshipped live issue's own `IssueStanding`. If any is stuck, the requirement is `stuck`: `waitingOn` is that issue's wait with `ref` set to it, `carriedBy` and `stuck.via` are its key, and the issue with the oldest `stuck.since` wins. Otherwise a parked issue gives its own wait, as today. Otherwise, when all have landed, the release turn applies, as today. Otherwise a running issue gives `moving`. Otherwise (open or reopen, nothing holding it) the wait is `master_take` from the issue's `since`. Either way, `nobody_serves` and `overdue` decide whether that becomes stuck. |
| issue → feedback | An `issue` route reads the carriers that are not dropped. If every one is closed, the item is `resolved` (unchanged). If any carrier is a draft, the phase stays `triaged`, not `planned`; the group is `stuck` with code `draft_carrier` (`nobody_serves` where no master serves); and the wait is the project's master ("The project's master: take on ISS-284"), never a person (REQ-68 BC-4, BC-6). Otherwise the phase is `planned`, and the wait is the first unshipped carrier's own standing, rolled up as above; a carrier that waits on a person reads as the master's to move on ("move ISS-n on"). `issueWait` survives only for the release leg. |
| any → done | Declined and verified feedback, and accepted or dropped requirements, are `done`. They are never stuck, late or at risk. |

`FEEDBACK_ATTENTION_GROUPS` gains `stuck`, placed after `needs_you`. `REQUIREMENT_ATTENTION_GROUPS`
already has it; it moves to second place, above `moving` (BC-9).

### Screens and tools that switch to the read, and what gets deleted

| Surface | Reads after | Deleted |
|---|---|---|
| Dashboard At risk | `standings` rows where `stuck` is set, then forecast-late moving items, each row's text taken from its standing. "Lands this week" reads the same standing: a stuck requirement or feedback item forecasts `paused` on what its standing names, with the stuck reason, never a landing (`forecast/scope.ts:stuckWaitOf`). | `project-home/derive.ts:atRiskRows` "short" branch and `BUILT_STATES`. `forecast/late.ts:lateWaiting` (the 24h person wait, which `overdue` replaces). `forecast/feedback.ts:feedbackLinesOver` forecasting done items. |
| Dashboard BA panel | `standings` | `project-dashboard/ba-derive.ts:feedbackFigures` aging and closed rules. The `late`/`worst`/`lateOfDelivery` copy in `planRows`. |
| Requirement list "Waits on" and groups | `RequirementStanding` (`StandingTimes` included) | `requirement-roadmap.ts:waitsLineOf` English parsing; it reads `says` keys. |
| Requirement and feedback banners | `waitingOn`, plus `stuck.reason` and the note | `RequirementBanner` no-owner inference. `FeedbackBanner` "ship" for draft carriers (this comes from core). |
| Feedback page body | The same standing as the banner | `feedback-progress.ts:estimateOf` wait text for an item with a standing. `product-progress/feedback-views.ts:noDeliveryOf` English. |
| Feedback phase view | `phaseOf`, which no longer reads a draft carrier as planned | |
| Issue list "last write" cell and the board's "unheld" column | `IssueStanding.group` / `stuck` | `issues/waiting.ts:sinceLastWrite` (24h). `pipeline/derive.ts:rowColumn` "unheld". |
| List filters | `needsViewer` | `ui-list-filters.ts:waitingFilterOf`'s "you" from `kind`. |
| Chat `forge_project_status` and the status report | Section 6 | |

## 2. Steward note (BC-7, BC-8)

| Item | Decision |
|---|---|
| Storage | `steward_notes` (migration 507). It is insert-only, and a write supersedes the current row in the same transaction. Columns: `id`, `project_id`, `subject_kind` (requirement, feedback or issue; issue added by migration 511), `subject_id`, `lines text[]`, `cites jsonb`, `claims jsonb`, `basis`, `written_by`, `run_id`, `written_at`, `superseded_at`. A partial unique index on (`subject_kind`, `subject_id`) where `superseded_at` is null. |
| Door | `PUT /api/projects/:id/steward-notes/:subjectKind/:key`, with body `stewardNoteWriteSchema`. The tool is `forge_steward_note`, whose actions are `get` and `write` and which share one function with the route. The writer is the project's steward account, or a person holding `project.write` (an override, BC-12). Anyone else gets `STEWARD_NOTE_FORBIDDEN`. |
| Shape | Line 1 says what happened and what blocks. Line 2 says what is next and by when. The note has 1–2 lines of at most 160 characters each, 1–8 cites, and `claims` (group, waitingKind, ref, stuck, stuckCode, dueAt). |
| Vet at write | 1. The subject is in the project, else `STEWARD_NOTE_SUBJECT_UNKNOWN` 404. 2. No line holds a line break, else `STEWARD_NOTE_TOO_LONG` naming `/lines/i`. 3. Every cite resolves, else `STEWARD_NOTE_CITE_UNKNOWN` naming `/cites/i`. 4. A non-null `waitingOn.ref` is cited, else `STEWARD_NOTE_CITE_MISSING`. 5. `basis` equals the current standing's, else `STEWARD_NOTE_STALE` 409, returning the current basis. 6. Each claim equals the standing's field, else `STEWARD_NOTE_CONTRADICTS` naming `/claims/<field>` with both values. 7. A stuck standing's lines do not use another group's label ("Moving", "Planned", "On track"), and a not-stuck one does not say "stuck", else `STEWARD_NOTE_CONTRADICTS` naming `/lines/i`. |
| Written by the steward | The model writes the lines and may add cites. Code copies `claims` and `basis` from the standing the run read (`steward/note.ts:noteWriteOf`), with the subject and the waited-on `ref` always cited; the note door takes no claims from the model. If the door still refuses `STEWARD_NOTE_STALE`, `_CONTRADICTS` or `_CITE_MISSING` and a re-read shows the basis moved, the door rewrites from the new standing once; an unmoved basis returns the refusal as it is. |
| Cites | A `question` cite resolves to an `agent_questions` row or a question-intent comment on any of the project's records (requirement, feedback, issue, workflow); a `comment` cite to any of the project's comments (`standing/cites.ts`). |
| Rewritten when | Every steward act, plus `standing.changed` (the sweep sees the basis move off the note's). |
| Shown | On the requirement, feedback and issue pages; the issue page leads with a Stuck banner (core's stuck reason and whom it waits on) when the issue is stuck, as the two lines above the properties, with cites as links, then the properties, then the raw status row below them (BC-7). If `stale`, it is shown greyed with "Out of date: the standing moved", and the standing's own banner leads. Lists show line 1 as the row's secondary text. The chat report quotes line 1 on Stuck and Needs you rows. |
| Text | It is agent-written, so `verbatim` (`said.ts`) is used, with no registry keys. |

## 3. Steward runtime (BC-1)

### Triggers

They come through the existing outbox: one consumer named `steward` (`contracts/outbox-consumers.ts`,
`outbox/consumers.ts:consume`), using `delivery.inbox(tx)` for idempotency.

| Trigger (`STEWARD_TRIGGERS`) | Outbox event | Emitted by | Act |
|---|---|---|---|
| `requirement.agreed` | `requirement.agreed` (exists) | `requirements` agree | `intake_check` |
| `breakdown.proposed` | **`suggestion.proposed`** (new; kind breakdown) | `suggestions/propose.ts:createSuggestion`, `reviseSuggestion` | `breakdown_check` |
| `feedback.filed` | `feedback.filed` (exists) | feedback create | `triage_draft` |
| `standing.stuck` | **`standing.stuck`** (new) | the standing sweep | `stuck_diagnosis` |
| `release.asked` | `issue.transitioned`, to `awaiting_release` (exists) | the issue machine | `output_check` |
| `release.held` | **`release.held`** (new) | `release-batch/hold.ts:writeReleaseHolds`, when it writes a `RELEASE_CRITERIA_UNEARNED` hold (`criteria-hold.ts` only reads); `runId` is null for an automatic release | `output_check` |
| `release.shipped` | `release.shipped` (exists) | `pipeline/run-records.ts`, `release-batch/shipped-earlier.ts` | `release_followthrough` |
| `standing.changed` | **`standing.changed`** (new) | the standing sweep | `note` |

The **standing sweep** is a cluster timer `standing-sweep` in `timer-registry.ts:coreTimers`, running
every 5 minutes (`STANDING_SWEEP_MS`). For each project with the steward on, it calls
`OpenStandingsRead`. It emits `standing.stuck` for a stuck item that holds no steward run on its current
basis (`steward_runs.basis`). A stuck issue that carries a requirement or a feedback item is
diagnosed through that item, because the roll-up makes the carrier stuck with `via` set. Only an issue
nothing carries is a subject of its own, and its diagnosis writes it a note like any item. The sweep
otherwise emits `standing.changed` when an item's note exists and `basis` ≠ the note's basis; an
issue with no note is not noted by the sweep.

An item turning stuck by time alone is seen within 5 minutes. Nothing else needs a timer.

### Run record, debounce and idempotency

These use `steward_runs` and `steward_acts` (migration 508).

| Rule | How |
|---|---|
| Recorded on the item (BC-1) | One `steward_runs` row per run: subject, trigger, folded `events[]` (outbox ids), act, runtime, state, `job_id`/`turn_id`, times. Read through `GET /api/projects/:id/steward-runs?subject=` and on the item page's activity rows. |
| One live run per item | A partial unique index on (`subject_kind`, `subject_id`) where `state in ('queued','running')`. Insert-or-fold under that index. |
| Debounce, no act dropped | A new event folds into the queued row, adding its act to `acts_to_run` (distinct; run in `STEWARD_ACTS` order), and `not_before = first event + 2 min` (`STEWARD_DEBOUNCE_MS`). An event arriving while the run runs adds its act to `follow_up`, and the run's end queues those acts as the next run. A breakdown proposed during a note run is therefore still checked. |
| Start within 5 min | A process timer `steward-dispatch` runs every 30 s and claims queued rows whose `not_before` has passed (`steward/runs-store.ts:claimDueRuns`, one materialized `FOR UPDATE SKIP LOCKED` claim that never takes more than its limit). Runs from a handoff event are claimed and taken up before the sweep's `standing.stuck` backlog. The tick does not wait for the runs it starts: a project takes up to `slotsFor(budget)` runs at once (one per 25 daily turns, 1 to 8), core up to 16, and a run over its slots goes back to the queue. `started_at` is stamped when the run is admitted under the budget lock, not at claim. The bound is 2 min + 30 s under a 100-run backlog (`steward-dispatch-bound-e2e`). |
| One cause, diagnosed once | A requirement or feedback item stuck through a carrier issue that is itself stuck is only noted; the carrier is diagnosed (`steward/sweep.ts:stuckCarrierOf`). |
| A job whose run ended | The pool never auto-retries a `steward` job (`contracts/jobs.ts:POOL_UNRETRIED_JOB_TYPES`): the steward's own sweep owns a retry. A job counts as live only while its run is queued or running (`runs-store.ts:liveStewardJobOf`), so an ended run's job holds no runner act back. |
| Idempotent | The outbox delivery commits with the row (`delivery.inbox`). Each run stores the basis it read. A `note` run whose standing basis equals the note's is `skipped` / `basis_unchanged`. A subject that ended is `skipped` / `subject_ended`. |
| Lost wake | The sweep re-emits a stuck item that holds no run on its current basis. A stuck item already diagnosed on that basis is not diagnosed again until its standing moves. |
| A refused act | A run whose turn finished but a door refused an act ends `failed` with `failure_kind` `refused` and each refusal named. It holds its basis like a done run, so the sweep does not retry it until the standing moves. A run that broke (`failure_kind` `error`: a turn that did not finish, or a write a door answered 5xx) holds its basis for an hour, then is retried. |

### Where each act runs

There is no provider key. Gateway turns use the assistant's gateway (`integrations/llm/chat.ts:openChat`,
`fast-model.ts:callFastModelObject`).

| Act | Runtime | Why |
|---|---|---|
| `note`, `intake_check`, `breakdown_check`, `stuck_diagnosis`, `output_check` | **Core gateway turn** (`assistant/run-turn-core.ts:runTurnEvents`). The note uses the fast model, and the rest the default. | These read records only, and the checks are mostly deterministic reads the tools return. Each fits in seconds and costs one turn. |
| `triage_draft` (BC-4), `release_followthrough` (BC-10) | **Runner job**, type `steward`, issue-less (template: `onboarding/job.ts:enqueueJob`). The prompt carries the method, so the runner does not branch on the type. | These need the codebase and the running build: a reproduction with evidence (`reproduce.ts`), a cited root cause, and verdicts judged on the running build. |

The runner job is claimed like any pool job (`devices/claim.ts`). Where no runner is bound, the run
ends `failed` naming it, and the note says so. It never falls back to a gateway guess.

The brief's last step is the job's done door, `POST /api/projects/:id/steward-runs/:runId/done`
`{ refused: string[], broken?: string[] }`, fenced to the project (`project.read`) and callable only
by its steward account (`STEWARD_RUN_FORBIDDEN`) on a running job run, or an ended one whose job is
still live (`STEWARD_RUN_NOT_JOB`), so a settlement cut short is finished by the retry. It ends the
run done, or `failed` naming each write (`refused` for a 4xx, `error` for a 5xx), ends the job as
onboarding's done door does, and revokes the job's token last. The job's own `job.transitioned` delivery
also revokes a steward job's token whenever the job ends, so a revoke a done call lost still lands. Without it an issue-less pane idles until
the runner reaps it as an infra failure, which failed job 3fb50ccb after its acts were done.

Each gateway menu opens with `steward_read_item`, the read for the run's own subject by its kind.
An issue door (`steward_read_issue`, comment, move) refuses a `REQ-` or `FB-` key by name, naming the
read that takes it; `GET /api/issues/:key` does the same. `steward_ask` takes a requirement key alone, and a feedback key there is refused naming `steward_decide`, which asks a stuck feedback item's decision (BC-5).

### Account, grants and turn identity

| Item | Decision |
|---|---|
| Account | One agent account per project, display name "Steward", created lazily like `conversations/handles.ts:resolveProjectHandle` (`credentials/agent-account.ts:agentAccountRow`). It is a project member. |
| Grants (`project_members.grants`) | `project.write`, `suggestions.write`, `feedback.approve` and `suggestions.approve` (see decision 2). Each act's token names only the approvals that act uses (`STEWARD_ACT_APPROVALS`): `breakdown_check` rejects a breakdown and never accepts one, and `triage_draft` accepts only its own `feedback_triage` suggestion, which the accept door holds to (`suggestions/accept-fence.ts`). It never declines, and holds no `issues.admit`, `releases.approve`, `plans.approve` or `project.admin`. |
| Gateway turn | `TurnOrigin` gains `'steward'` (`credentials/turn-credential.ts`). `permissions/turn-authority.ts:resolveTurnAuthority` accepts the project's steward account. `mintTurnCredential` takes `STEWARD_TURN_MENU`. `assistant/turn-origin.ts:fenceToolsetToOrigin` cuts the toolset to the act catalogue's doors. |
| Runner job | The job brief carries a credential minted by `mintAgentCredential` for the steward account, narrowed to the same menu. |
| Master nudge | `ws/master-wake.ts:MASTER_WAKE_SOURCES` gains `steward`, and so does the runner's reader (`runner-daemon` `WakeSource`). The durable half is `masters/owed.ts:readMasterWork` gaining `stewardAsks`, so a missed wake is read on the next box sweep. |

### Cost guard

| Guard | Value |
|---|---|
| Live runs per item | 1 (index above). |
| Runner jobs live per project | 1 (an explicit `liveJobOf` check, as onboarding does). |
| Daily budget per project, by UTC day | 200 gateway turns and 10 runner jobs (`STEWARD_DAILY_BUDGET`). When spent, the run is `skipped` / `budget_spent` and the note says so. Lowered per project through the project document's `steward` policy key (`{ enabled, budget }`; `enabled` defaults to true). |
| Usage | Recorded with `recordModelCallUsage`, as `intake/service.ts:recordSpend` does. |
| No-op | Skip when the basis is unchanged. |
| Handoffs keep a share | 40% of each day's turns and jobs (`policy.ts:HANDOFF_SHARE`, `sharesOf`) is kept for handoff-event runs; the sweep's `standing.*` runs spend only the rest. A handoff run spends its own share and whatever the sweep left, and is skipped `budget_spent` only when the whole day is spent. A handoff folded into a queued sweep run makes it a handoff run, due on the handoff's own clock (`runs-store.ts:foldTrigger`). On dev.271 the first sweep's backlog spent the whole day, and every later run, handoffs included, ended `skipped budget_spent` (`steward-dispatch-bound-e2e` replays it). |
| Follow-throughs keep a share | 40% of each day's runner jobs, rounded up (`policy.ts:FOLLOWTHROUGH_SHARE`, `followthroughReserveOf`: 4 of the default 10), is kept for release follow-throughs, the judge a shipped issue is owed; no other run may spend it, so a run that is not a follow-through is skipped `budget_spent` once the rest is spent. A follow-through spends its share and whatever else the day has left; one the whole day cannot pay for is not ended but waits, queued, for the next UTC day, and the steward says so on the issue (`dispatch.ts:runOne`, `note.ts:judgeOwedNote`). On 2026-10-22 four feedback triages and two follow-throughs spent the 10 jobs by 02:38, and dev.287's three judges were skipped with nothing written (`steward-batch-guard-e2e`). |
| The sweep is paced | The sweep raises no more runs than its share has room for (its spend plus its queued runs), longest stuck first (`sweep.ts:sweepRoom`, `byAge`). A sweep run its share cannot pay for is not ended: it waits in the queue for the next UTC day, in its place (`dispatch.ts:runOne`, `next_day`), so the backlog drains over days, oldest first. |
| A quiet steward is seen | `GET /api/projects/:id/steward-budget` (`policy.ts:budgetDayOf`) reads each share and what it spent, how many stuck items wait for a later day, and `quiet`: `handoffs` where the day is spent, `sweep` where only the sweep's share is. The Dashboard draws one line under Needs you when `quiet` is set (`web-v2 features/standing/components/steward-budget-line.tsx`). |
| Concurrent runs | Admission (`steward/policy.ts:admitRun`) holds the `stewardBudget` advisory lock and counts, as spent, the gateway acts still owed by runs already started, so runs started together cannot overspend the day. |

## 4. Act catalogue (BC-2..6, BC-10, BC-12)

Every act goes through an existing door, as the steward account, and is logged in `steward_acts`
along with its undo. One new door undoes any act: `POST /api/projects/:id/steward-acts/:actId/undo`
(needs `project.write`). The person authorises; the steward account, which made the act, executes
its inverse door, and the act records who asked (`undone_by`). Without an inverse, it refuses
`STEWARD_ACT_NOT_UNDOABLE`, naming the override.

Every item page (requirement, feedback, issue) lists the steward's acts in its Activity
(`web-v2 features/standing/components/steward-acts.tsx`, from `GET …/steward-acts?subject=`, every
act on the item newest first and uncapped, so newer runs never push an old act off): what each did
and when, with Undo for a `project.write` member where a door undoes it, the act's
`override` sentence where none does (`steward/undo-rules.ts:personOverrideOf`), or Undone. A
question records the account that asked it through `POST /api/questions` (`agent_questions.asked_by`,
migration 0512), and every question read names it as `asker`, so the steward's questions show
"Asked by Steward" in the item's Activity. A question the system asked (a sweep, a run's park) names
no asker.

The steward reads a stuck feedback item's triage proposals with its viewer `project.read`
(`GET …/suggestions?feedback=FB-n&status=proposed`), so its grant needs no addition.

| Act (BC) | Reads | Acts through (existing door) | Writes | Undo / override | When it may not act, it asks |
|---|---|---|---|---|---|
| `intake_check` (BC-2) | The head revision, current BCs, linked workflows and pins, the dedup check (`requirements` `similar`) | Gap: a question comment on the requirement (`POST …/requirements/:req/comments`, intent `question`, its options and the recommended one in the body), since `POST /api/questions` takes an issue. Complete: `POST …/requirements/:req/comments`, holding the **breakdown brief**. | Questions, or a brief comment. `masters/owed.ts` holds the requirement's breakdown out of `breakdownsOwed` while a steward intake question is open. | Delete the question comment or the brief (`DELETE …/requirements/:req/comments/:comment`); a comment somebody replied to is kept, refused `COMMENT_HAS_REPLIES`. | The author answers the questions in Needs you. |
| `breakdown_check` (BC-3) | The suggestion payload against current BCs: each traced or listed uncovered with a reason, `complexity` set on each issue (`suggestions` breakdown checklist) | `POST …/suggestions/:sid/reject {reason}`, naming each gap ("BC-4 untraced; 'Export CSV' unsized"). The act's token names `suggestions.approve`, and the steward's accept of a breakdown is refused by the accept door. | A rejection. `breakdownsOwed` re-opens for the master, with the reason. | Undo re-proposes the same payload (`createSuggestion`, producer person). | Nothing is asked. A clean breakdown gets only a note. |
| `triage_draft` (BC-4) | The item, its evidence, the codebase, a reproduce preview (`reproduce.ts`), `feedback/similar` | `POST …/suggestions` (`feedback_triage`, with `diagnosis{recording, cause, fix}` and the route), or `/revise` of the assistant's draft. A duplicate becomes `duplicateOf`. Then `POST …/suggestions/:sid/accept` where no person gate asks and it holds `feedback.approve`. | The triage suggestion. Its accept routes it (`feedback/triage.ts:triageIn`). The note's 2 lines are the summary. | `POST …/feedback/:fb/reopen {reason}` sends it back to triage. | `POST …/feedback/:fb/clarification` with `recommended`, one at a time per reporter (`FEEDBACK_CLARIFICATION_ALREADY_OPEN`). A decline is never taken; it is a Needs you decision. |
| `stuck_diagnosis` (BC-5) | The standing, `stuck.code`, master standing, runs, the carrier's checklist | `nobody_serves` with a silent master: wake plus `stewardAsks`. A draft failing the ready checklist: `steward_prepare_draft` first (below). `draft_carrier` with the ready checklist complete and the admit gate off: `POST /api/issues/:id/transition {toStatus: open}`. `overdue` on a master act: wake plus `stewardAsks`. `overdue` on a judge: wake for QA. `no_owner`: `PATCH …/requirements/:req {owner}` names the author (its first revision's) as owner; an author who is no longer a member is refused `REQUIREMENT_OWNER_NOT_MEMBER` by name, and the note says who must own it. | The move, the wake, or the owner. A comment on the issue says why. | Owner: `PATCH` back to none. A question on an issue: `POST /api/questions/:id/void {reason}`. Comment: `DELETE /api/comments/:id`. Preparing: the link's `DELETE`, the prior plan and the prior criteria. Open: a person parks it (`on_hold`) or drops it. Wake: nothing to undo. | One decision on the issue, `steward_decide`, with Forge's own options (below). Nothing is asked where the wait is an act somebody already owes: a release approval, an open question, a design decision or a blocker is woken or noted. |
| `output_check` (BC-6, see decision 1) | Each carried criterion's latest verdict and `notCounted` (`requirements/standing-coverage.ts:resolve`), the issue's design record proof plan, and the release facts (`release-batch/steward-release-facts.ts:stewardReleaseFacts`: what landed work still owes at its landing) | Gap: the note names each criterion, the evidence missing and the commit it is owed at, and wakes the master. The steward moves no issue back: a status moves only by an explicit act (2026-10-26, after its reopens bounced catalog-fe ISS-16..19 off the gate each time a person moved them there). On `release.held`, the same for each held issue. | The note. | Nothing to undo: it moved nothing. | Nothing is asked. The master is woken to dispatch a judge where only a verdict is missing. |
| `release_followthrough` (BC-10) | The shipped issues, carried BCs, the running build (`GET /api/issues/:id/judged-build`) | `POST /api/issues/:id/verdicts` (identity `runtime`, so it is independent of the builder). `POST …/requirements/:req/comments`, "what shipped" in BA words (one per requirement, reusing `release-page/highlights.ts`'s highlight where one exists). The release's own notice asks each routed item's reporter to confirm, with the criterion's verdict and clip (`notifications/notify-feedback.ts`); `POST …/feedback/:fb/tell-shipped` only where an item's standing still owes the relay. | Verdicts and a comment. | Verdicts are insert-only, so a person's later verdict supersedes. Delete the comment. | The reporter answers whether the problem is gone (the existing loop-check). |
| `note` (BC-7) | `ItemStanding` | `PUT …/steward-notes/:kind/:key` (new, lane A) | The note | A person's write overrides it. | — |

### A stuck item's decision (BC-5)

The first live run asked 43 questions in forge-dev's Approvals with about 30 spellings of one choice,
most recommending "complete the plan and criteria, then open". A person is never asked to write a
plan or criteria: preparing a draft is the steward's own act, done before it asks anything
(coordinator ruling, 2026-10-22). The issue-ready check is not loosened. The options are code's
(`contracts/steward.ts:STEWARD_DECISIONS`).

| Rule | Decision |
|---|---|
| Prepare first | A draft that fails the issue-ready check is prepared by `steward_prepare_draft` (`steward/door-prepare.ts`) as the Steward account, through the issue's own doors: it links the agreed requirement (`POST …/requirements/:req/issues`), saves a short plan (`PATCH /api/issues/:id {plan}`, which records that requirement's current revision as `planned_revision`), and writes the issue's criteria traced to its BCs (`PUT /api/issues/:id/criteria`). The requirement is the carried feedback's triaged one (`criterion: REQ-n BC-m`), else the best agreed one by area and title (`steward_list_requirements`). A criterion is a checkable statement written from the feedback case and the BC text; one reading as an instruction ("Verify …") is refused, as is a requirement not agreed or accepted, or a BC it lacks. Each write is its own act with its own undo. The driver rewrites the short plan in its own phase. |
| The set, an issue | `stewardDecisionsFor(status, stuck code, ready)`: a draft that passes the check offers `open`, `keep`, `drop` (`steward.open`, `steward.keep`, `steward.drop`), recommending `open`; a draft that does not, where no agreed requirement fits, offers `link` (`steward.link:REQ-n:BC-m`, the steward's candidates, at most 3, best first), `requirement` and `drop`, and never `open`. Either draft may also be offered `merge` (`steward.merge:ISS-n`) into a live issue the turn names. Open, reopen or on_hold work that `nobody_serves` offers `keep`, `drop`. Any other reading offers none, and `steward_decide` tells the turn to wake or note instead. No option asks anyone to write details. |
| The set, a requirement | `stewardRequirementDecisionsFor`: a draft requirement whose draft its author does not finish (or that holds no revision) offers `merge` (`steward.merge:REQ-n`, into a live requirement the turn names), `drop` and `keep`; a draft revision of a requirement past draft offers `withdraw` (`steward.withdraw`) and `keep`. A proposed revision, or a head waiting to be agreed, is an approver's act: none. This replaces the stale-draft sweep (below). |
| The set, a feedback item | `stewardFeedbackDecisionsFor(act)`, only while the item reads stuck: a triager's act (triage it, route it, triage it again) offers `keep` and `drop` (decline); the reporter's verify of a shipped fix offers `verify` (`steward.verify`), `reopen` (`steward.reopen`) and `keep`. A reporter's answer to confirm, or a carrier's act, offers none. Before this, `steward_ask` refused a feedback key and `steward_decide` took an issue key alone, so a stuck feedback item whose next act was a person's got no question at all (the BC-5 judge on round 2). |
| Where it is asked | `POST /api/projects/:id/steward-runs/:runId/decisions {about, prompt, options, recommendedOptionId, why, basis}` (`steward/decision-ask.ts`), by the project's steward account alone (`STEWARD_DECISION_FORBIDDEN`), naming a run of the project, every option one of the set (`STEWARD_DECISION_OPTIONS_UNKNOWN`). A merge option names what the two items are both about in `shares` (`STEWARD_MERGE_SHARES_MISSING`), and their titles share at least `STEWARD_MERGE_SHARED_TERMS_MIN` subject words (`contracts/steward.ts:stewardSharedTerms`), else `STEWARD_MERGE_NOT_SAME_SUBJECT`: sharing a requirement is not the same subject (REQ-48 r3 BC-16). An issue's question stands on the issue and a requirement's on the requirement; a feedback item's names it under `about: {kind: feedback}` (migration 0513), since an item's own question is its reporter's clarification, which triage voids and the reporter is shown. Core builds every option's envelope and fingerprint. `POST /api/questions` refuses the set's ids (`QUESTION_OPTIONS_STEWARDS`), so no second door asks a decision that acts. |
| The model's part | `steward_decide { about, recommended, candidates?, into?, shares?, why }`: the item (ISS-n, REQ-n or FB-n), the recommended decision, the link candidates (each checked agreed with that BC current), the merge target (a live item of the draft's own kind about the same thing, with `shares` saying what both are about; an unrelated one is said back to the turn and no merge is offered), and one line of why, kept as the round's own `why` beside the question. The labels and the question are code's: the question is the one plain sentence the options make (`contracts/steward.ts:stewardDecisionQuestion`), with neither the item's title nor the recommendation in it (REQ-48 r3 BC-14). No second question while any question is open on the item, of any kind; none where a person answered keep, through any question (the retired stale-draft one included), since the item came to read as it does now (`steward/door-decide.ts:keptNow`). |
| The menus | `stuck_diagnosis` holds `steward_prepare_draft`, `steward_list_requirements` and `steward_decide`, and no `steward_ask`; `steward_ask` takes a requirement key only, for `intake_check`'s content questions. A turn calling a door outside its act's menu is refused by name (`steward/turn.ts:stewardToolset`). |
| The answer acts | The answer is carried out as the answerer in the act's own transaction (`questions/answer.ts:answerQuestion` → the `carryStewardDecision` port → `steward/decision-act.ts`). `open` moves the draft to open through the kernel: the issue-ready check still applies, and its refusal (`CHECKLIST_INCOMPLETE`) refuses the answer and leaves the question open. `link` links the draft to the requirement it names and emits `standing.stuck`, so a new run prepares it and asks `open`; that run is budgeted like any other and skipped `budget_spent` once the day is spent. `requirement` starts a draft requirement from the carried feedback as the requirement door writes one (`requirements/index.ts:createRequirementIn`), in the answer's own transaction, and the assistant proposes its area as on any new requirement. `drop` drops it with the answerer's `note`; `keep` records the keep with its `note`; either without a note is `STEWARD_DECISION_REASON_REQUIRED`. `open`, `link`, `requirement` or `merge` on an issue no longer at draft is `STEWARD_DECISION_STALE`. An issue's `merge` copies its text to the target as a comment and drops it in the same move; a target that ended is `STEWARD_MERGE_TARGET_ENDED`, and a draft holding a live `blocks` edge or carrying feedback is `STEWARD_MERGE_HAS_DEPENDENTS`, since a merge moves text and not links. A requirement's `drop`, `withdraw` and `merge` are the requirements module's own writes (`requirements/steward-decision.ts`): `drop` and `merge` take a signer, as the drop door does, `withdraw` the draft's author or a signer, and only the draft revision that stood when the question was asked (one started after it is `STEWARD_DECISION_STALE`); `merge` writes what the draft says that the target does not as a proposed revision of it (`mergedWrite`) and drops the draft naming it, refused by the revision door's own code where one is already open (`REQUIREMENT_REVISION_OPEN`). A feedback item's `drop` declines it as the triage's decline does, holding `feedback.approve` and the reason the reporter reads; `verify` and `reopen` hold the reporter's own door's rules (`feedback/steward-settle.ts`), so a verify of an item not resolved is `FEEDBACK_NOT_RESOLVED`. Every refusal refuses the answer and leaves the question open. |
| Logged | Each answer's act is a `steward_acts` row on the run that asked (`POST /api/issues/:id/transition`, the merge's comment, the link, the requirement made, a requirement's drop, withdraw or merge, a feedback item's decline, verify or reopen, or `KEEP <key>`). The link is undone by its `DELETE`; the others are refused `STEWARD_ACT_NOT_UNDOABLE` naming the override, like the steward's own move. |
| Budget | Preparing is part of the diagnosis turn, so it spends that run's gateway turn against the daily budget (`steward/policy.ts`). |
| Needs you | Group `answer`, the question drawn from the options (`stewardDecisionQuestion`), never the stored prompt, so a round asked before r3 reads the same; recommended `by: steward` with the round's `why` (migration 0516 carried it out of the older prompts once); a merge option naming nothing shared is left off the buttons, and recommends none where it was the recommended one; each button's `effect` saying what it does to the item (`contracts/steward.ts:stewardDecisionEffect`: "Opens ISS-n as you; its driver plans it…", "Keeps ISS-n as a draft until its standing moves…", "Drops ISS-n as you…", "Declines FB-n as you; its reporter reads your reason.", "Proposes what REQ-n adds as a revision of REQ-m, then drops REQ-n, as you."), never the generic run answer, `keep`, `drop`, `withdraw` and `reopen` with `needsReason`; the typed reason rides as the answer's `note`. A requirement with the steward's question open reads `answer the steward's question`, waiting on a signer (`requirements/steward-asked.ts`). A feedback item's question opens the item it names (`opens: {kind: feedback}`). |
| The stale-draft sweep, retired | The hourly `stale-draft-sweep` asked merge, drop or keep on a draft untouched for 7 days, beside the steward: two live paths for one job. Deleted: the sweep (`requirements/stale-drafts.ts`), its timer, its answer consumer `stale-draft-act` (`requirements/stale-draft-act.ts`) and its outbox entry, the issue reads it asked from (`issues/stale-drafts.ts`, the issue standing's `staleDraft` input and its two turns), the requirement standing's `mergeOrDropAsked` and `mergeOrDropRefused` turns, the contract `contracts/stale-drafts.ts` (`DRAFT_STALE_DAYS`, the option ids, `isStaleDraftQuestion`), the Needs you group `merge_or_drop` and its builder, the assistant's `merge-or-drop` prompt layer, the question option's `target`, and the said keys `standing.act.mergeOrDrop`, `standing.act.draftAnswerByHand`, `standing.rule.draftAnswerRefused`, `issues.rule.staleDraftAsked` and `requirements.rule.staleDraft`. What it did that the steward did not moved first: merging a draft into the live item it repeats, dropping a draft requirement, and withdrawing a draft revision of an agreed one are now the steward's decisions above, with the same refusals. What changed by design: the steward asks once a draft reads stuck by its own due, not at a fixed 7 days. `steward/retire-stale-drafts.ts`, a boot backfill (`stale-draft-questions-retired`), voids every stale-draft question still open, naming why, and emits `standing.stuck` for its item where it still reads stuck, so nothing answers into a consumer that is gone. An answered drop or merge that consumer never carried out (its draft still a draft, its round recording no outcome) is carried out once as the person who answered it, through the steward decision's writes (`steward/retire-stale-answers.ts`); one a rule refuses is recorded on its round by name. An answered keep on one is still read before the steward asks. |
| The questions already asked | `steward/reask-once.ts`, a boot backfill (`steward-free-form-questions-reask`): every open steward question whose options are not the set is voided naming why, and each item its run was on that still reads stuck is emitted `standing.stuck`, so the steward asks again with the set, or not at all. |

## 5. Needs you (BC-11)

| Rule | Decision |
|---|---|
| One list | `development/needs-you-decisions.ts:readNeedsYouDecisions` is the only Needs you. The Dashboard, the requirement list's Needs you group and count, `/attention`, the chat tool `forge_needs_you` and the chat report all read it. `project-status/read.ts:waitsOf`'s `needsYou` count is deleted. A list draws `needs_you` only for rows the viewer's decisions read holds. A draft requirement with no current revision has nothing to agree, since an agree pins a current head (`requirements/rules.ts:agreeRefusals`, Requirement lifecycle: an approver agrees the head), so its standing names its owner's own work, `write a revision` (`requirements/standing.ts`), never `agree it`; it read `agree it` on `/needs-you` while the decisions read classed it as work, and the key `standing.act.agreeIt` is deleted. An `agree rN` decision pins the current revision, never a newer withdrawn one. |
| Only what the steward may not take | A decision stays only if the steward account lacks the act's permission, a person gate (`person-gates.ts`) asks a person, or the question is the steward's own question to a person. Rows the steward may take leave Needs you and start the steward instead, so `notDecisions.awaiting_proposal` ("take on or drop") becomes the steward's `draft_carrier` act. A release cut stays: only `project.admin` cuts and the steward holds none, so a draft release no gate holds is its admin's `release.cut` decision. The requirement or feedback item waiting on that cut reads `waiting`, so the decision is the release's alone (`contracts/needs-you-decisions.ts:isDecisionActOn`). |
| Cap and order | At most 3 per person at a time (`NEEDS_YOU_PERSON_CAP`). Order: those carrying a stuck item first, then overdue by `dueAt`, then `NEEDS_YOU_DECISION_GROUPS` order, then oldest first. The rest are counted as "+n more", linking `/attention`, and never dropped. |
| One click | The existing `DECISION_ACTS` button with `recommended`. `decisionRecommendationSchema.by` gains `steward`. `DECISION_ACTS` gains `issue.admit` (`POST /api/issues/:issueId/transition {toStatus: open}`), `requirement.defer` and `release.cut` (`POST /api/projects/:projectId/release-batches {issueIds}`, the release page's own cut). A cut's consequence reads "Cuts <version> carrying ISS-…", its peek lists the issues with what each proves, and the rule recommends it only where every criterion they carry is earned (`development/needs-you-approve-builders.ts:cutDecision`). Each row carries a reason, which is the steward note's line 1. |

## 6. Chat report

| Change | Where |
|---|---|
| `forge_project_status` leads with `stuck` (the `ItemStanding` rows where stuck is set, each with key, title, `stuck.reason`, the note's line 1 and an href) and `needsYou` (the top 3 decisions, each with its recommended act), then the rest. | `project-status/read.ts:readProjectStatus`, `project-status/tool.ts` |
| A section with nothing in it is left out, not sent as zeros. A table whose every number cell is 0 is dropped, and one line names what was left out. | `project-status/read.ts`, `reports/tool.ts` (`forge_report` composer) |
| The digest line order becomes stuck, needs you, shipped, next release, since last report. | `status-reports/digest.ts:digestText` |
| The web report and its Markdown copy follow the same section order. Stuck and Needs you are `status-list` blocks with linked rows. | `features/project-status/components/status-report.tsx`, `report-markdown.ts`, `contracts/visual-blocks.ts` (an existing kind) |

## 7. Migrations

These take the numbers this work owns. Merge order is lane A, then lane B. Lane B rebases the one
journal line.

| Index | `when` | Tables | Lane |
|---|---|---|---|
| 0507 | 1826755200000 | `steward_notes` | A |
| 0508 | 1826841600000 | `steward_runs` (with `acts_to_run`, `follow_up` and `basis`), `steward_acts`. Also `jobs.type` value `steward`, if the column carries a check. | B |
| 0512 | 1827187200000 | `agent_questions.asked_by` (BC-12) | round 2 |
| 0513 | 1827273600000 | `agent_questions_about_shape_chk` takes `{kind: feedback, feedbackId}` (BC-5) | round 2b |

## 8. Lane split

These are two parallel lanes. The contract between them is `packages/contracts/src/steward.ts`,
landed now, with these exports:
- `ItemStanding`, `StandingTimes`, `StuckReading`, `STUCK_CODES`, `STANDING_DUE_WORKING_DAYS`
- `standingBasisOf`, `OpenStandingsRead`
- `StewardNote`, `stewardNoteWriteSchema`, `stewardClaimsSchema`
- `STEWARD_TRIGGERS` / `STEWARD_TRIGGER_EVENT` / `StewardEventPayloads`
- `STEWARD_ACTS`, `STEWARD_ACT_RUNTIME`, `StewardRunView`, `StewardActRecord`
- `STEWARD_REFUSAL_CODES` and their statuses (registered in `refusal-statuses.ts`)
- `NEEDS_YOU_PERSON_CAP`

Lane B calls lane A only through `OpenStandingsRead` and the note door. Until A lands, B tests both
against a fake that implements the type.

| | Lane A: standing and surfaces | Lane B: steward runtime and acts |
|---|---|---|
| Contracts | `requirements.ts`, `feedback.ts`, `issue-standing.ts` (extend `StandingTimes`; feedback `stuck` group), `needs-you-decisions.ts`, `requirement-roadmap.ts`, `ui-list-filters.ts`, `said-keys.ts`, `project-status.ts` | `outbox-events.ts`, `outbox-consumers.ts`, `jobs.ts` |
| Core, owned | New `core/src/standing/` (read, stuck, due, roll-up, routes, `forge_standing`). New `core/src/steward-notes/` (store, vet, routes, `forge_steward_note`). `requirements/standing*.ts`, `feedback/standing.ts`, `feedback/list-read.ts`, `issues/standing*.ts`, `forecast/late.ts`, `forecast/feedback.ts`, `forecast/feedback-progress.ts`, `product-progress/feedback-views.ts`, `mcp/requirement-views.ts`, `development/needs-you*.ts`, `project-status/*`, `status-reports/digest.ts`, `reports/tool.ts`, `db/schema-steward-notes.ts`, migration 0507 | New `core/src/steward/` (consumer, runs store, `steward-dispatch` and `standing-sweep` timers, account, turn, job, prompts, acts, undo door, runs routes). `db/schema-steward-runs.ts`, migration 0508. Emit-site edits: `suggestions/propose.ts`, `release-batch/criteria-hold.ts`. `outbox-consumers.ts`, `timer-registry.ts`, `credentials/turn-credential.ts`, `permissions/turn-authority.ts`, `assistant/turn-origin.ts`, `ws/master-wake.ts`, `masters/owed.ts`, `db/schema-jobs.ts` |
| Runner | none | `runner-daemon` `WakeSource` gains `steward` |
| Web | Every surface: `features/project-home`, `project-dashboard`, `requirements`, `feedback`, `issues/waiting.ts`, `pipeline/derive.ts`, `project-status`, `conversations` report blocks. Also the note and run rows on item pages, reading B's runs route by its contract type. | none |
| Shared, one line each | `route-registry.ts`: A mounts `standingRoutes` and `stewardNoteRoutes`, and B mounts `stewardRoutes`, each beside its neighbours (after `feedbackRoutes` for A, after `suggestionRoutes` for B), so the hunks do not touch. `_journal.json`: A takes 507 and B 508; B rebases. | |

Each lane ships a test that plants the defect it fixes and watches it go red:
- **Lane A:** REQ-45's shape (a reopen carrier with master `none`) must read stuck. FB-74's shape (a draft carrier) must read triaged and stuck, the same on all four surfaces. A declined FB-89 must not be at risk. A contradicting note must be refused, naming the field.
- **Lane B:** two events within 2 minutes give one run. A third event during a run gives one rerun. A spent budget skips the run and says so. A stuck item gets an act within an hour.

## 9. Workflow designs

| Flow | Change | State on dev Forge, 2026-10-21 |
|---|---|---|
| `steward-handoffs` (new, `f6c435fb-00af-4b50-bfad-0d5b3fe1ba79`) | The steward's own flow, 22 steps: 8 trigger events → `handoff` rule → `steward` case → 7 tasks (intake check, breakdown check, triage draft, stuck act, output check, follow-through, note) → act or ask → result, feeding back to the one standing read. It is a flow of its own because requirement-to-delivery holds the schema's 40-step cap. | r2 proposed |
| `requirement-to-delivery` r17 → r18 | Stays at 40 steps, with no new steps. `expect-breakdown` becomes `expect-next` (every wait has a due, by act class), and `stalled` becomes `stuck` (the four stuck codes, replacing "untouched 21 days"). `turn` gains the roll-up condition and outputs since, dueAt, stuck and carriedBy. `delivery`, `agreed`, `release-gate`, `fb-case` and `released` name the steward's act (BC-2, 3, 4, 6, 10). | Validated. Waits on a drawing issue (`WORKFLOW_DESIGN_ISSUE_REQUIRED`: r17's ISS-526 is closed). |
| `feedback-lifecycle` r15 → r16 | `planned` needs every carrier past draft; a draft carrier keeps the item triaged and stuck (BC-9). New regions `steward-triage` (BC-4) and `steward-note` (BC-7). `resolved` adds the follow-through (BC-10). `declined` is never late. | Validated. Waits on a drawing issue. |
| `issue-lifecycle` r18 → r19 | `awaiting_release` and its entry edge drop the stale verdict clause to match `transition-guards.ts` and REQ-45 BC-1/2. Entry starts the steward's output check. `awaiting_release → reopen` names that check. `open`, `reopen` and `draft` carry their due and stuck readings (BC-5). | Validated. Waits on a drawing issue. |

## Honest costs

- **Model spend on every handoff.** At the default budget, a busy project pays for up to 200 gateway
  turns and 10 runner jobs a day. A project that spends its budget by noon gets no steward for the
  rest of the day; the note says so, and nothing else does the work.
- **An agent that moves things.** The steward opens drafts, rejects breakdowns and routes feedback
  without anyone pressing a button; it no longer sends issues back to reopen (2026-10-26). A wrong act is visible and undoable,
  but someone has to notice it first.
- **A second writer of text on every page.** Notes are agent prose. The vet catches a contradiction
  of the standing's fields, not a misleading sentence that agrees with them.
- **Stuck reads louder.** With one-day and two-day dues, many items that read Moving today will read
  Stuck the day this lands. The Dashboard gets worse before it gets better.
- **One more consumer and two more timers.** The outbox gets a `steward` consumer, and the cluster
  gets a 5-minute standing sweep over every open item of every project. That is a read of all
  standings each time.
- **A runner wake source.** `steward` must ship in the runner before core sends it. Until then, the
  wake is a loud refusal on the box, and the durable `stewardAsks` read carries the nudge.

## 10. Open decisions

Each has a recommendation; the design above is written to it.

1. **BC-6 contradicts REQ-45 BC-1 and BC-2.** REQ-45 says an agent moves an issue to awaiting_release
   "with no verdict required first", and verdicts are "judged on the release that carries the work".
   `issues/transition-guards.ts` asks no verdict on that edge.
   - **Recommend** REQ-48 r2 for BC-6: "When an issue enters awaiting_release, the steward checks each
     carried criterion has a counting verdict on the running build or a proof the release will run,
     and a release that holds an issue back for an unearned criterion is answered the same way;
     otherwise it sends the issue back naming the missing evidence."
   - This is a reaction, not a new gate. The kernel's release hold (`release-batch/criteria-hold.ts`)
     stays the only hold.
2. **Steward grants.**
   - **Recommend:** `project.write`, `suggestions.write` and `feedback.approve`, by policy never
     declining.
   - **Decided (2026-10-21):** add `suggestions.approve`, so BC-3's rejection lands. The act fence
     stays the limit: `breakdown_check` may only reject, never accept, and `triage_draft` may accept
     only its own `feedback_triage` suggestion; each act's token names only its own approvals.
   - **Recommend withholding** `releases.approve`. Closing shipped work then becomes a one-click
     decision for a release holder, not the steward's own act. BC-5 lists "close work already shipped"
     among the acts the steward takes "where it holds the permission".
3. **The deep triage reads the codebase.** REQ-34 BC-11 says the assistant drafts from the product
   record and never the codebase.
   - **Recommend:** the assistant's instant draft keeps that rule. The steward's runner job is a
     separate actor that may read the codebase and a reproduce preview, because BC-4 asks for a
     reproduction and a cited root cause.
4. **No master serves the project.**
   - **Recommend** the steward asks one question with a recommended act. It does not dispatch runs
     itself, because REQ-48 puts "replacing the master" out of scope.
5. **The At risk 24h person-wait (`lateWaiting`) is replaced** by `overdue` with person_decide at 2
   working days. The forecast's p85 late stays for moving items.
   - **Recommend** yes.
6. **The budget defaults** are 200 gateway turns and 10 runner jobs per project per day.
   - **Recommend** accepting them as the start, and reading the usage after a week.
7. **REQ-48 links three workflows, and the steward lives in a fourth.**
   - **Recommend** that REQ-48 r2 (together with decision 1) links `steward-handoffs`, so its baseline
     pins it.
