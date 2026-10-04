# The question entity has two writers, and only one of them creates a question

**Removed when:** an ask, answer or void publishes a realtime event open screens refetch on and
`blocked.rs`'s `park_for_human` is wired or deleted, and forge-plugin ISS-2317 has shipped `forge
record question`, which dev ISS-138 carries. The change that lands it deletes this file.

First measured 2026-09-23 against `main` at `710ab641` and the installed plugin at `3.36.262`
(ISS-1210); rewritten 2026-09-27 by ISS-1257, which coupled a question to the issue it stops
without letting the question move the issue's status. Written because the split runs across a repository boundary this repo cannot gate, and the
way it was found was an owner staring at an empty panel for nineteen hours.

## What core owns

The entity, its doors and everything that reads it:

- `packages/core/src/questions/` — `write.ts` (`insertAskedQuestion`, the one path every door's
  question is written through; `askQuestion`, `askParkQuestion`, `answerQuestion`, `voidQuestion`),
  `issue-coupling.ts` (the open questions on an issue, and the terminal refusal or void that rides
  in the issue transition's transaction), `read.ts` (`askAs`, `projectQuestionsFor`,
  `readQuestionsForIssue`, `registerWaiter`, `waiterFor`), `routes.ts`, `screen.ts`,
  `origin.ts`, `protections.ts`, `batch-item.ts`
- `POST /api/questions` on a personal access token, in `questions/routes.ts`, through `askAs`
- `POST /api/devices/me/questions` and `GET /me/questions/:questionId?runId=` on a device pairing,
  in `devices/pool-routes.ts`
- two screens: the issue decision panel (`web-v2` `features/questions/components/decision-panel.tsx`),
  where a question on an issue is answered, and the Agents screen's Questions tab
  (`features/agents/components/questions-pane.tsx`), which lists only the open questions that name
  no issue. A question on an issue also shows on that issue's row in the Issues list, aged from the
  oldest open question blocked on a person (`issues/list-projection.ts:REST_ISSUE_LIST_COLUMNS`).
- two sweeps that key on a question row: `jobs/park-deadline.ts`'s `parkedOnAHuman`, which exempts a
  processless human park from the residency reaper, and `reapUnansweredParks`, which is that park's
  replacement clock

## How the question and its issue stay in step

`issues/apply-transition.ts:transitionIssueStatus` is the one writer to `issues.status`. A question
and the status are two facts: the status says how far the work has got, and an open question with
blocker kind `human` is the **marker** that a person owes the issue an answer. The marker is never
stored — `questions/issue-coupling.ts:holdsOpenHumanQuestion` reads it from the question rows every
time, so answering or voiding the last one clears it with no second write. The Issues list's
`Needs you` (`orWaitingOnPerson` on the search, and `waitingOnPersonByStatus` in its buckets), the
issue page's banner, the Attention count (`me/attention-buckets.ts`) and the row chip each read
status OR marker.

- **An ask moves nothing.** `askAs`, behind `POST /api/questions`, writes the
  question and leaves the issue at its rung, whatever the blocker kind.
- **Into `needs_info`.** A park is a deliberate move, taken for want of a requirement. Every agent
  or device park leaves an open question (`issues/park-question.ts`), `skip` or not: it mints one,
  unless no `needs` was sent and a `human` question is already open — that is then the question it
  waits on. A person's own move to `needs_info` mints nothing.
- **Out to `closed` or `dropped`.** Refused with `OPEN_QUESTIONS` while a question on the issue is
  open, naming the ids, unless the move carries `voidQuestions` — then each is voided with that
  sentence, `ended_reason: 'issue_terminal'`. Every door refuses an ask on a terminal issue
  (`QUESTION_ISSUE_TERMINAL`).
- **Out of `needs_info` on an answer.** On an autonomous project, `pipeline/answer-resume.ts` moves
  the issue once its last open question is answered, and not before: back to the status the park
  left (`issue_work_state.left_status`), never a guessed one. A park that recorded none waits for a
  person to move it, and an answer at any other rung moves nothing.
- **The wedge reset** (`pipeline/reconciler.ts:resetAutonomousWedgesOnce`) leaves an issue holding
  the marker at its rung: its next move is a person's, so it is not wedged.

## The writers, and what each one produces

| Writer | Where it lives | Creates a question row | Moves the issue |
|---|---|---|---|
| `mintParkQuestion` | `packages/core/src/issues/park-question.ts` | yes, on every agent or device park to `needs_info` | it runs inside that park |
| `askAs` | `packages/core/src/questions/read.ts`, behind `POST /api/questions` | yes | no |
| `forge-runner question ask` → `transport::questions::ask` | `packages/runner/crates/forge-runner/src/cmd/question.rs` | yes, on the box's device pairing | no |
| `forge record question` | `github.com/SidCorp-co/forge-plugin`, `plugin/` | **no** — it writes a `forge-record: question` comment and nothing else | no |

The last is the half this repo cannot gate: its record reads correctly to a human in the thread,
and no question row carries the options or the need it wrote. That, and the CLI having no verb that
reaches `POST /api/questions`, are forge-plugin's to fix and are reported there.

## What binds the halves that ARE here

The runner and core do not import each other, so the body the box puts on the device door is pinned
as a file: `packages/runner/crates/forge-runner-core/assets/question-ask-wire.jsonl`. The runner
asserts it sends exactly those bodies (`cmd/question.rs`). Core's half — that the door takes them
and stores what they carry — has no test on dev, where the TypeScript tests were deleted; nothing in
core reads the file until they are restored.

## What is still true and was not fixed

- **A person's answer at a rung other than `needs_info` reaches no session.** `answer-resume` hands
  an answer to the session that asked only while the issue is parked; a run that asked about
  finished work reads the answer back with `GET /api/questions/:id`.
- **No browser is told a question changed.** An ask or an answer publishes no websocket event, and
  since neither moves the issue, an Issues list or an issue page already open shows the marker,
  `Needs you`, its count and the banner as of its last fetch until it refetches (focus, remount, or
  its own poll — which the issue page's question read skips while the issue holds none).
- **`issue_id` stays nullable.** A master's question from the device door may carry none, and those
  are what the Questions tab still lists. Making the column `NOT NULL` breaks the runner's wire.
- `packages/runner/crates/forge-runner-core/src/runner/blocked.rs` — `arm_bounded` and
  `park_for_human` — still has no caller outside its own tests, so no run declares itself parked on
  a person, and `parkedOnAHuman` matches nothing on a box.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| A close can now be refused for a question | An automated close (a release batch, a reconciler) that meets an open question fails that issue by name instead of closing it; the release path already records the failure and recovers the stranded row. The price is that a moot question must be answered or voided before the work reads done |
| `voidQuestions` lets whoever closes void a person's question | Voiding stays off the REST token door (`POST /api/questions/:id/void` is a session's), and an agent voids only inside a close it makes, with a sentence on the record. An actor entitled to close the issue is trusted to say the question died with it |
| Four routes to one entity | A reader asking "how did this row get here?" has four answers to check. The pinned wire file has to be edited whenever the device body changes |
| Writing the split down does not close it | This document has to be rewritten the day `forge record question` creates the entity or the device door parks; until then it is a second place the coupling is described |
