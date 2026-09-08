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
