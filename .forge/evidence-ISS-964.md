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
