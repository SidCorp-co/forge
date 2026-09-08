# ISS-964 — red-first evidence (criterion 60)

One row per criterion claim. `RED` is the failure the test printed BEFORE the code that made it
green, quoted from the run, not paraphrased. A row with no RED quote is not evidence.

This file is deleted in the final commit of the issue and its content posted as the criterion-60
comment. It lives on the branch rather than in a scratch dir so it survives a lost session.

| # | Criterion | Test | RED (quoted) | Commit |
|---|---|---|---|---|
| 29 | token minted per session, mapped token→session | `session_tokens::a_token_names_exactly_one_session` | `error[E0433]: failed to resolve: use of undeclared type SessionTokens` | S2 |
| 29 | the map survives the daemon that minted it | `a_token_survives_the_daemon_that_minted_it` | same E0433 — the store did not exist | S2 |
| 29 | a respawn leaves no live capability behind | `re_minting_replaces_the_previous_token_for_that_session` | same E0433 | S2 |
| 29 | the capability dies with the session | `retiring_a_session_retires_its_token` | same E0433 | S2 |
| 30 | a frame naming another session is served as the token owner | `control::a_frame_naming_another_session_is_served_as_the_token_owner` | `error[E0026]: variant control::Request::Prepare does not have a field named token` | S2 |
| 30 | an unknown token names nobody | `control::a_frame_carrying_no_known_token_names_nobody` | `error[E0433]: use of undeclared type SessionTokens` | S2 |
| 31 | no frame declares a session; every frame carries a token | `control::no_frame_declares_a_session_and_every_frame_carries_a_token` | `error[E0026] ... does not have a field named token` (the enum still had `session_id`) | S2 |
| 13 | no shape discriminator anywhere in first-party source | `questions/one-shape.test.ts` | `expected 'src/db/schema-questions.ts\nsrc/quest…' to be ''` after planting `const answerShape = 1` — and the first version of this test was itself red-proof-blind: `git grep` reads the index, so `--untracked` was added when the planted line in an unstaged file did not register | S3 |
| 14 | a question with no recommended option is refused | `agent-questions-e2e` #1 | mutation A (`if (false)` over the recommendation check): `promise resolved "{ …(19) }" instead of rejecting` | S3 |
| 14 | a recommendation must be one of the question's own options | `agent-questions-e2e` #2 | mutation A, same shape | S3 |
| 16 | an option bound to one call must name the call | `agent-questions-e2e` #3 | mutation A (`if (false)` over the fingerprint requirement) | S3 |
| 16 | a permission presented for a different call is refused BY NAME | `agent-questions-e2e` #4 | mutation A (`if (false)` over the fingerprint comparison) | S3 |
| 20 | a chain is ONE row with steps[] | `agent-questions-e2e` #5 | mutation C (follow-up mints a fresh row): `a chain that mints a second row is N queue rows for one decision: expected '8243c647…' to be '7b7c83fa…'` | S3 |
| 21 | a fourth round is refused and the thread becomes the record | `agent-questions-e2e` #6 | mutation B (`if (false)` over `max_rounds`) | S3 |
| 22 | a drifted premise voids WITH a reason and the queue shrinks | `agent-questions-e2e` #7 | mutation B (reason not required, `void_reason` not written) | S3 |
| 15 | a member sees the whole question; only admin options lock | `agent-questions-routes-e2e` #1 | mutation A (`mayChoose` returns true always) | S4 |
| 15 | a viewer sees the question with nothing choosable | #3 | mutation A | S4 |
| 15 | a locked option cannot answer anyway | #4 | mutation A | S4 |
| 15 | a writer seeing NO question is the named failure | #1 | mutation B (`readQuestionFor` returns null unless admin): `a writer seeing no question at all is the failure criterion 15 names: expected null not to be null` | S4 |
| 18 | the answer is not consumed by the read | #5 | mutation D (`answerOf` clears `chosenOptionId` after returning): `expected null to match object { Object (optionId) }` | S4 |
| 18 | one answer revives all N waiters | #6 | mutation C (answering deletes the waiters): `expected [] to deeply equal [ 'run-a', 'run-b' ]` | S4 |
| 12 | an answer reaches a box that was offline all episode | #7 | mutation D — the read-back is the only delivery path, so consuming it loses the answer | S4 |
| 17 | stop reaches terminal with no process behind it | #8 | mutation C (the write gated on the session having a device): `expected 'running' to be 'cancelled'` | S4 |
| 19 | the expensive question outranks the cheap one that arrived later | `attention-awaiting-cost-order-e2e` #1 | restored `desc(issues.updatedAt)`: `expected [ 'ISS-2', 'ISS-1' ] to deeply equal [ 'ISS-1', 'ISS-2' ]` | S5 |
| 19 | claims outrank workspaces outrank dependents | #2 | same restore, ages set opposite to costs so no `updatedAt` direction can produce the order | S5 |
| 19 | age breaks a tie, oldest first, and is still returned | #3 | same restore: `desc` reverses it | S5 |
| 19 | an issue a human blocked by hand stays, below the costly ones | #4 | same restore — the hand-blocked row is deliberately the NEWEST | S5 |
| 19 | only an OPEN question costs anything | #5 | same restore — the settled row is deliberately the NEWEST | S5 |
| 19 | two open questions on one issue SUM rather than max | #6 | same restore — the two-question row is deliberately the OLDEST | S5 |
| 23 | the cap is 20, not `PER_BUCKET` | #7 | `expected undefined to be 20` before `AWAITING_INPUT_CAP` existed; independent of the ordering, so it is the one case the restore leaves green (6 of 7 red) | S5 |
| 4, 5 | a human block releases the box, machine/peer keep it | `ledger::a_human_block_releases_the_box_and_a_machine_block_keeps_it` | mutation A (`incarnation` fixed to `Live` for every kind): `assertion left == right failed: left: Live, right: Exited` — and 5 downstream revival tests with it, because they stand on `Exited × Blocked` | S6 |
| 3, 6 | a `nobody` blocker is refused and writes no question | `a_blocker_nobody_could_resolve_is_refused_and_writes_no_question` | mutation B (`if false` over the refusal, `Nobody` given a wire value) | S6 |
| 9 | the ledger alone tells waiting from dead | `the_ledger_alone_tells_waiting_from_dead` | mutation A — the two rows stop differing in the pair of typed columns | S6 |
| 35, 36 | a refuted pid from another boot refutes nothing | `liveness_is_three_valued_and_a_foreign_boot_is_never_dead` | mutation G (`&& false` on the boot comparison): `Dead` where `Unknown` is owed | S6 |
| 40, 42 | revoking increments the generation and stales every claim under it | `revoking_a_claim_makes_every_claim_under_it_stale` | mutation C (`claim_generation = claim_generation`): the fence stops moving and the stale revival is admitted | S6 |
| 38 | an answered park is `exited × runnable`, and exactly one wake wins the CAS | `an_answer_leaves_the_run_owed_a_revival_and_exactly_one_wake_wins` | mutation D — the CAS predicated on `work='blocked'`, which is the wrong version criterion 38 NAMES: it matches zero rows and the run is owed a revival forever | S6 |
| 38 | a failed revival returns the row still owed, never to blocked | `a_revival_that_never_spawned_returns_the_row_still_owed` | mutation E (`work='blocked'` written on the way back): the run waits for a second answer nobody sends | S6 |
| 39 | recovery resets only an EXPIRED attempt | `recovery_resets_an_expired_revival_and_leaves_one_on_its_way_alone` | mutation F (deadline predicate replaced with `?1 = ?1`): an attempt between CAS and exec is reset, which is how a second wake wins | S6 |
| 41 | a revival is refused BY NAME on a gone tree or closed work | `a_revival_is_refused_by_name_when_its_tree_is_gone_or_its_work_is_closed` | covered by the enum being checked before the CAS; no mutation needed beyond D, which shows the CAS itself is load-bearing | S6 |
| 10 | a question is recorded under the id the BOX minted, idempotently | `a_question_is_recorded_under_the_id_the_box_minted_and_repeats_idempotently` | the id is the primary key and the write is `INSERT OR IGNORE`; a server-allocated id would not be re-postable by the reconcile sweep | S6 |
| 8 | a park survives the ledger being closed and reopened | `a_park_survives_the_ledger_being_closed_and_reopened` | file-backed, not in-memory — nothing about the park lives in the process | S6 |
| — | an OLD ledger gains the new columns on open | `a_ledger_written_by_an_earlier_build_gains_the_new_columns_on_open` | mutation H (the ALTER pass never runs): `no such column: claim_owner` on a ledger written by the previous build — the live one on forge-vm | S6 |
| 10 | the arm order is tx → open the door → declare, and the declaration cannot precede the open | `blocked::a_door_that_cannot_open_leaves_the_run_runnable` · `blocked::a_bounded_arm_declares_live_blocked_and_the_door_answers` | mutation I (declare against a door opened elsewhere, real door opened after): red on both, no compile error — the run reads `live × blocked` with the ring landing in a gap nothing reads | S7 |
| 10 | the open door is a PARAMETER of the declaration, not a convention | `blocked::the_live_declaration_cannot_be_written_without_an_ear` | mutation J (`_ear` removed AND the call site repaired, so the compiler cannot see it): red on the source scan alone | S7 |
| 11 | `ENXIO` is a tier change, not an error | `doorbell::a_ring_nobody_is_listening_for_is_an_outcome_not_an_error` · `doorbell::dropping_the_ear_stops_the_door_being_heard` | mutation K (`ENXIO` mapped to `Err`): the ringer's fast path fails on the slow path's ordinary success | S7 |
| 11 | an undrained door is still `Heard` | `doorbell::a_door_nobody_drains_still_counts_as_heard` | mutation L (`EAGAIN` mapped to `NoListener`): a question the run is live and waiting for gets parked because a previous ring was not read | S7 |
| 11 | no control action blocks on the thing it controls | `doorbell::neither_arming_nor_ringing_waits_on_the_other_side` · `doorbell::a_ring_reaches_a_listener_holding_the_door` | 200,000 rings against an undrained door inside 20s; without `O_NONBLOCK` the write blocks at the first full pipe and the read blocks until a writer appears, so neither call returns at all | S7 |
| 3, 6 | `nobody` is refused BEFORE anything is written | `ledger::a_blocker_nobody_could_resolve_is_refused_and_writes_no_question` | mutation M (`refuse_nobody` moved below `begin_question`): the question row criterion 6 forbids is there | S7 |
| 4, 5 | the two arms refuse each other's blocker by name | `ledger::the_bounded_arm_refuses_a_human_block_by_name` | mutation N (the human guard deleted from `arm_bounded`): an unbounded human wait is declared `Live` and holds a runner slot with no bound | S7 |
| 5, 7 | the human park opens NO door | `blocked::the_human_park_exits_and_leaves_no_door_behind` | mutation O (`park_for_human` given a `ledger_path` and opening a door with it — the realistic regression, since the signature is what prevents it today): red with no compile error | S7 |
| 12 | `answer: null` is *not yet* and a 404 is *not this box's question* | `transport::questions::a_question_this_box_is_not_the_waiter_for_is_an_error_not_an_empty_answer` · `an_unanswered_question_on_a_live_route_reads_as_none` | mutation P (404 mapped to `Ok(None)`): another box's question reads as one this box waits for forever. Held over a real socket — a decode test cannot reach a status code | S7 |
| — | a 401 is `Unauthorized`, not a generic failure | `transport::questions::an_expired_credential_is_reported_as_unauthorized` | mutation Q (the 401 branch deleted): the caller retries the same dead token instead of re-authenticating | S7 |
| — | a refusal from core reaches the caller with its status and body | `transport::questions::an_ask_that_core_refuses_names_the_status_and_the_body` | mutation R (body discarded, message flattened): the operator sees `question ask failed` where `400: prompt required` was available | S7 |

### S (post-S7 repair) — `park_for_human` discarded the blocker

The `Wait` params struct introduced to clear clippy's `too_many_arguments` destructured with
`..` in the human arm, dropping `blocker`. Before the struct the arm was chosen *by choosing the
function*, so a mismatch was unrepresentable; after it, `park_for_human(led, Wait { blocker:
Machine, .. })` released the box for a wait measured in seconds **and** wrote
`blocker_kind = Human`, because `declare_parked_human` hard-codes it — the row named the wrong
resolver. `blocker: Nobody` wrote the question row criterion 6 forbids.

Probed before fixing: `MACHINE-AS-HUMAN => Ok(Exited) row=(Exited, Blocked, Some(Human))` ·
`NOBODY-AS-HUMAN => Ok(Exited) questions=[("q", 1)]`.

| Mutation | Red |
|---|---|
| restore the `..` discard in `park_for_human` | `the_human_park_refuses_a_bounded_blocker_and_writes_nothing` + `the_human_park_refuses_nobody_before_writing_the_question`, both at the assert (compiles clean — the real regression shape, not a compile error) |

The `refuse_nobody` guard claimed "in both arms" while only one arm called it; the claim is true
now rather than aspirational.

## S9 — the park protections and the capability gate (c24, c25, c26, c27, c34)

Landed BEFORE any producer, which is the safe side of criterion 27 rather than the letter of it:
`park_for_human`, `arm_bounded`, `park_protections` and `stopSession` still have no production
caller, verified by grep at commit time. 27 forbids a producer shipping ahead of the protections;
this is the reverse order, and the producer wiring (c5b, c7, the control verbs, c28, c32/c33)
carries the permit that only exists because of this commit.

Three premises re-read on this tree before writing, all confirmed unmoved: the heartbeat exemption
already existed (so c24 extends one exemption story rather than adding a second mechanism);
`parkedSessionFor` still joins through `jobs` and requires `awaiting_input` non-terminal; and
`reap_repo` still judged on age ∧ clean ∧ nothing-unpushed with no pid, session or ledger read.

### The discriminator, and the bug the first design had

`NOT EXISTS (open agent_questions)` was the wrong exemption and would have un-reaped the case
residency exists for: `begin_question` is step one of BOTH arms of `runner/blocked.rs`, so a
machine or master-or-peer park writes an open row too — and those keep their process. The
discriminator is `blocker_kind = 'human'`, since only the human branch releases a process (c5).

| Mutation | Red |
|---|---|
| T1 widen the residency exemption to any open question | `still reaps a machine park…` + `still reaps a master-or-peer park…` |
| T2 read a NULL `park_deadline_at` as expired | `never closes a park the asker set no deadline on` |
| T3 drop the floor on the day count | `floors the named duration at one day` |
| U1 widen the answer-resume branch to any blocker kind | `is not claimed for a machine park…` + `…master-or-peer…` |
| U2 drop the waiter join | `is not claimed when no run registered as a waiter` |
| U3 drop the issue predicate | `is not claimed by a park open on a different issue` |
| U4 log the branch but fall through to the fallback | `dispatches nothing and leaves the issue parked` |
| V1 drop the reaper's ledger consult | 3 hold tests, incl. criterion 36's own case |
| V2 answer the hold question with `live_run_at_path`'s predicate (`incarnation='live'`) | `refuses_a_clean_pushed_silent_tree_a_park_still_holds` + `holds_a_park_that_outlived_the_boot_it_was_made_in` |
| V3 ignore the path key in the held snapshot | `a_hold_on_another_tree_shields_nothing` |
| V4 let an ended run keep holding its tree | `reaps_a_tree_whose_run_has_ended` |
| W1 grant the permit on any-of instead of all-of | `a_core_running_only_some_of_them_grants_no_permit` |
| W2 grant the permit on an empty advertisement | 3 permit tests |
| W3 remove `&ParkPermit` from the signature, call sites repaired | `the_human_park_cannot_be_written_without_a_permit` (no compile error) |
| W4 the runner's own reaper stops consulting the ledger | `the_ledger_reaper_this_permit_claims_is_in_this_build` |

### The old/new matrix — two tests and one procedure, said as such

- **new runner + old core** → no advertisement → no permit, refusal naming what is missing.
  `an_old_core_advertising_nothing_grants_no_permit`, plus the partial case W1 covers.
- **old runner + new core** → a park minted before ISS-964 carries no question row and must STILL
  be reaped: `still reaps a park that predates the question table`. Asserted this way round because
  "the new code is inert when nothing changed" cannot go red.
- **downgrade with a park already open** → NOT a test this box can run. It is what 27a's procedure
  exists to make safe, and it is on the issue as a comment before any deploy.

Claiming three tests here would have been a green that cannot fail.

### One refinement to criterion 27, declared

The criterion says core advertises the three protections. Core advertises **two** —
`park-exempt-residency` and `answer-resume-park` — because the third, `worktree-reap-ledger`, is
the runner's own reaper and core cannot observe which runner build is asking; advertising it would
be core promising something it has no way to know. The runner requires all three: two from the
advertisement, the third asserted from its own source by
`the_ledger_reaper_this_permit_claims_is_in_this_build`. Each assertion is made by the side that
can actually make it. `park-protections.test.ts` keeps core's two from becoming empty promises by
reading the source behind each name.

### Paid, not waived

- `loop-monitor.ts` went 1 line over its frozen size budget. Paid by grouping the two park clocks
  into `parkClocks` (−7 lines), NOT by `--update-baseline`.
- CM013 on the same file paid by converting its `Claim hop:` restatement block to the `cm:guard`
  that block's last two sentences already were.
- The stale claims corrected in this commit rather than left standing: `worktree_reap.rs`'s
  *"a drive session runs 60-90 minutes"* (both the module guard and the age-gate test's), and
  `loop-monitor.ts`'s *"a parked session still holds its runner slot, and the residency deadline
  is what bounds it"* — a processless park falsifies both halves.
- `failure_reason` took ONE fixed member (`park_unanswered`, origin `user`, so it stays out of the
  real-failure rate); the per-park duration lives on the question's `ended_reason`. A dynamic
  `unanswered_2d` in the closed taxonomy would land every park in `unclassified`.
- Gates as reported at the time: `pnpm verify` 20 ok / 0 red · core 5959 unit, 1292 integration ·
  web-v2 906 + build · `cargo fmt --check`, `clippy --workspace --all-targets`,
  `test --workspace` (418) · `pnpm build` 4/4.
- **Correction — that verify line was wrong, and the commit shipped one red gate.** Re-run at
  `86cfce659` in a detached worktree: **18 passed · 2 did not run · 1 red**, the red being
  `form size-budget` on `loop-monitor.test.ts` (529 counted lines against a 527 baseline — the two
  lines S9 added to `aggregates all hop results`, never paid). Core lint and lint-budget were green
  there, which is how the reds in the next step's first run were identifiable as new. Paid in S9a
  by folding four `mockReset(); mockResolvedValue()` pairs into chained calls, not by
  `--update-baseline`. The lesson is the one the repo already states: read the gate's own summary
  line, never a recollection of it.

## S9a — three defects on the park path S9 left open (c24, c25, c26, c34)

Found by reviewing S9's own claims rather than by a new requirement. All three are inside the
ownership line and in reach, so all three are fixed here (`fix-it-now`, not filed).

### 1 · The reaper compared two path spellings that do not come from one source

`HeldTrees::holder` did string equality on `worktree_path`. The two sides derive it differently: a
run records `resolve_repo`'s answer, which prefers what the **server** serves
(`daemon/dispatch.rs`, server-first at the `repo_path` fallback), while the sweep enumerates
`cfg.bindings`. On the fleet those differ — jobs run under `/home/forge/projects/<slug>` — so one
symlink or bind mount makes the same directory two strings, the lookup miss, and the park deleted
by the reaper that exists to spare it.

Fixed by canonicalising **both** sides: `from_ledger` keys every hold under its written spelling
AND its resolved one; `holder` resolves the candidate first and falls back to the raw path (a
ledger row whose tree is already gone can only be keyed raw).

- `X1` — drop the read-side resolve → `holds_a_park_when_the_sweep_is_the_one_walking_a_symlink` red.
- `X2` — drop the write-side resolve → `holds_a_park_the_ledger_recorded_under_a_different_spelling`
  red, its message showing the park's tree in `removed`.
- Two tests because the two halves cover one direction each; either alone leaves one green.

**Residual, named not fixed:** `Ledger::live_run_at_path` carries the same assumption
(`worktree_path = ?1` string equality) and is what makes criterion 12 true — its failure mode is
two agents on one worktree. It cannot be canonicalised in SQL; it needs a Rust-side compare over
the live rows. In reach but not this step's subject, and changing the refusal that guards
`git worktree add` wants its own measurement. Carried in the issue comment.

### 2 · A job under a closed park was blamed on infra, and retried

`reapSessionLostJobs` wrote ONE cause for every way a session can die: `session_lost` / `infra`.
`deriveActionFromKind('infra')` is `retry`, so closing a park dispatched a fresh agent onto an
issue whose question nobody had answered — criterion 26's failure through the other door. The
session's own `failure_reason` is now the discriminator (`jobs/session-lost-cause.ts`), and
`park_unanswered` joined `SYNTHETIC_REAP_ERRORS` so the lifecycle sync cannot write the job's cause
back over the session's (the ISS-877 shape measured on epodsystem 2026-09-05).

- `Y1` — park inherits `infra` → `never retries a job whose park went unanswered` red.
- `Y2` — default flips to the park cause → 5 red, including all three silent-death reasons.
- `Y3` — `park_unanswered` dropped from the marker set → the marker test red.
- `Z1` — one cause for every death (the pre-fix code) → `is not retried…` red end to end.
- The `toBe(0)` retry claim is discriminating: its paired positive
  (`is still retried when the session simply died`) asserts `toBeGreaterThan(0)` and passes, so the
  harness can produce a retry descendant and a zero is a suppressed retry rather than an inert lane.

### 3 · A THIRD clock reaped a live park, and nothing had exempted it

`reapOrphanedOneShotRuns` judges liveness on `last_heartbeat_at`, and parking freezes that column.
A run session is exactly the shape that lands there — `issue_id` is NULL, and
`pipeline_runs_issue_kind_chk` makes that incompatible with `kind='issue'`, so `reapJoblessRuns` can
**never** see one. Measured: a live park with an unbounded deadline was force-failed
`heartbeat_timeout` and its run closed, about three minutes after parking. That is the whole of the
park undone, by the one sweep S9 had not looked at.

Fixed by adding a park term to that sweep's liveness clause, through `parkedOnAHuman(sessionId)` —
now the ONE writer of the predicate, shared by all three sweeps, because a fourth copy is how one
of them keeps reaping what the other two spare. Advertised as a third core protection,
`park-exempt-oneshot`, and required by the runner (`PROTECTIONS_FROM_CORE` is now 3).

- `W5` — drop the park term → `leaves a live park alone however long its heartbeat has been frozen`
  red, and `has the code behind park-exempt-oneshot in this build` red with it.
- `W6` — widen the predicate to any open question → 4 red across both clocks, every one a
  machine/master-or-peer park that must still be reaped.
- Regressions held: a jobless run whose session really died still reaps `heartbeat_timeout`; a
  machine park still reaps.

### Priced

- `size-budget` on `loop-monitor.test.ts` — paid by chaining four mock-reset pairs (−4 lines).
- `CM013` on `agent-session-link.ts` — paid by converting the `pm`/`pipeline` metadata restatement
  to the `cm:edge contract` it always was (the `metadataType` filter is the other half).
- `organizeImports` on `loop-monitor.ts` and on `sweeper.ts` — paid by hand, not
  `biome check --write`.
- `CM001` + `CM013` on `sweeper.ts` — the new `cm:guard` landed above ISS-442's nine-line legacy
  block, which made that block mine and stopped it being spared. Folded to one guard carrying the
  rule (`shrinking the grace toward heartbeatMs restores the failure`) and the citation, dropping
  the narrative. 60 of that file's 76 legacy prose comments are now cleaned.
- `CM013` on `loop-monitor.ts` — raised by the commit hook, which is where that rule holds (it
  needs a base revision, so `verify` does not raise it mid-edit). Paid by folding the hop-threshold
  block: the floor rule and the ISS citations kept, the three-row env-name table deleted as a
  second copy of `getLoopThresholds`' own literals.
- No `--update-baseline`, no waiver, no skipped test.

### Criterion 27 note

The advertised set grew from 2 to 3, and the runner now requires all three. An old core advertising
the original two grants **no permit** — which is the correct answer, not a regression: a box must
not release its process to a core whose one-shot sweep will reap the park in three minutes. Since
no producer calls `park_for_human` yet, no deployed box can be refused by this change today.

## S9b part 1 — the external way out of every state (c32, c33)

`runner/terminate.rs`. Two verbs, and which one applies is **derived** from
`incarnation`, never passed: `Kill` where a process exists (`Live`/`Starting` in THIS boot),
`Abandon` where none does (`Exited`). A caller that could choose would eventually choose `Abandon`
over a live agent and leave it writing git into a tree the record says is free.

**Vocabulary note.** The criteria say `incarnation='none'`; the ledger's enum is
`live | starting | exited` and `declare_parked_human` writes `exited`. Code written against the
criteria's word would match no run on any box, so the guard on `verb_for` records the mapping.

**The four states** are `incarnation` × `work` (criterion 9's two axes): live×runnable,
live×blocked, exited×blocked (parked), exited×runnable (answered, awaiting revival). The verb
follows from the first axis alone.

**The four resources** are never enumerated by the criteria, which reference them twice (c33, c37).
The schema enumerates them, one closing column each — which is also criterion 37's one-writer-per-
resource: the process (`pid`/`incarnation`), the worktree (`worktree_gone_at`), the core session
(`session_terminal_at`), and the issue leases (`run_issues.lease_returned_at`, per issue). Three of
the four are `close_loop::close`'s to set by reading the world back, so this verb stamps none of
them — asserted by `the_verb_stamps_no_mark_of_its_own`. The fourth does not exist on the abandon
path by definition.

**The order is preserve → release → close → `end_run`, and `end_run` is last because it is what
un-holds the tree.** `held_worktrees` is `ended_by IS NULL`, so writing it earlier lets a
worktree-reap tick delete, inside that window, exactly the diff c33 says must survive — and every
behavioural test would still pass, because none of them runs a reaper between two writes. Held by
`the_release_is_written_before_the_run_is_ended`, which reads the source, because what is under
test is the order of two statements and both orders produce the same final row.

**A defect this found, in my own first design.** Handing every abandon to `salvage_wip` looked
equivalent to probing first. It is not: `pick_target` answers `refused` when it finds dirt it
cannot attribute, so a CLEAN park would have been refused because some stranger's worktree on the
same box was dirty. The run's own tree is now probed with `worktree_reap::holds_work` — made `pub`
so what `Abandon` calls preserved is exactly what the reaper calls safe — and salvage is called
only when there is something to lose. Case:
`a_clean_park_is_released_even_with_a_strangers_dirty_tree_on_the_box`.

**A test that could not fail, caught by its own mutation.** The first refusal test branched on the
outcome and accepted either answer; widening `preserved` to admit `refused` left it green. Rewritten
to force a determinate failure (salvage handed a repo root that is not a git checkout) and assert
the refusal hard. `committed_not_pushed` counts as preserved because the release is
`git worktree remove`, which leaves the branch ref and its objects in the repo.

- `T4` — salvage aimed at a branch no tree is on → 2 red, the refusal path firing end to end.
- `T5` — `end_run` moved ahead of the release → the ordering test red, naming its own rule.
- `T6` — a `Live` row from a foreign boot read as `Abandon` → `a_live_run_from_another_boot_admits_
  neither_verb` red. Criterion 35 permits no reclamation from unknown; its pid names whatever the
  kernel has since reused.
- `T7` — `preserved` widened to admit `failed` → the refusal test red (it did NOT go red against the
  first version of that test, which is how the untestable assertion was found).
- `T8` — the `holds_work` probe removed → the clean-park case red.

**No socket caller, deliberately, and it is the AC's own order:** criterion 31 puts the capability
token on `daemon/control.rs` **before or with** `Ask`/`Abandon`/`Kill`, never after. So these land as
verbs with no external door, exactly as S9's protections landed with no producer. Wiring them to a
socket that still trusts a caller-declared `session_id` is what c31 forbids.

- Gates: `cargo fmt --check`, `clippy --workspace --all-targets`, `cargo test --workspace` 430
  (from 421).
