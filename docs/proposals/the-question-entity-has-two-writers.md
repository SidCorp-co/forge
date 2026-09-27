# The question entity has two writers, and only one of them creates a question

First measured 2026-09-23 against `main` at `710ab641` and the installed plugin at `3.36.262`
(ISS-1210); rewritten 2026-09-27 by ISS-1257, which made a question and the issue it stops one
state. Written because the split runs across a repository boundary this repo cannot gate, and the
way it was found was an owner staring at an empty panel for nineteen hours.

## What core owns

The entity, its doors and everything that reads it:

- `packages/core/src/questions/` — `write.ts` (`insertAskedQuestion`, the one path every door's
  question is written through; `askQuestion`, `askParkQuestion`, `answerQuestion`, `voidQuestion`),
  `issue-coupling.ts` (the open questions on an issue, and the terminal refusal or void that rides
  in the issue transition's transaction), `read.ts` (`askAs`, `projectQuestionsFor`,
  `readQuestionsForIssue`, `registerWaiter`, `waiterFor`), `routes.ts`, `screen.ts`, `stop.ts`,
  `origin.ts`, `protections.ts`
- `POST /api/questions` on a personal access token, in `questions/routes.ts`, and the MCP tool
  `forge_questions` (`mcp/tools/forge-questions.ts`) — both through `askAs`
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

`issues/apply-transition.ts:transitionIssueStatus` is the one writer to `issues.status`, and both
halves of the pairing run inside its transaction:

- **Into `needs_info`.** Every agent or device park mints a question (`issues/park-question.ts`),
  `skip` or not. An ask through `askAs` whose blocker kind is `human`, on an issue not already at
  `needs_info`, IS that park: one transition carrying the asked question whole; on an issue already
  there, the question is written only while the locked status still reads `needs_info`. A status
  that moved under either write (a resume, another park) is refused — `QUESTION_ISSUE_MOVED` or
  `STALE_TRANSITION` — and `askAs` decides again on a fresh read. Other blocker kinds only write
  the question. A person's own move to `needs_info` mints nothing.
- **Out to `closed` or `dropped`.** Refused with `OPEN_QUESTIONS` while a question on the issue is
  open, naming the ids, unless the move carries `voidQuestions` — then each is voided with that
  sentence, `ended_reason: 'issue_terminal'`. Every door refuses an ask on a terminal issue
  (`QUESTION_ISSUE_TERMINAL`).
- **Back to `open`.** `pipeline/answer-resume.ts` returns an autonomous issue once its last open
  question is answered, and not before.

## The writers, and what each one produces

| Writer | Where it lives | Creates a question row | Moves the issue |
|---|---|---|---|
| `mintParkQuestion` | `packages/core/src/issues/park-question.ts` | yes, on every agent or device park to `needs_info` | it runs inside that park |
| `askAs` | `packages/core/src/questions/read.ts`, behind `POST /api/questions` and `forge_questions` | yes | parks at `needs_info` for a `human` blocker |
| `forge-runner question ask` → `transport::questions::ask` | `packages/runner/crates/forge-runner/src/cmd/question.rs` | yes, on the box's device pairing | no |
| `forge record question` | `github.com/SidCorp-co/forge-plugin`, `plugin/` | **no** — it writes a `forge-record: question` comment and nothing else | no |

The last is the half this repo cannot gate: its record reads correctly to a human in the thread,
and no question row carries the options or the need it wrote. That, and the CLI having no verb that
reaches `forge_questions`, are forge-plugin's to fix and are reported there.

## What binds the halves that ARE here

The runner and core do not import each other, so the body the box puts on the device door is pinned
as a file both suites read: `packages/runner/crates/forge-runner-core/assets/question-ask-wire.jsonl`.
The runner asserts it sends exactly those bodies (`cmd/question.rs`); core asserts the door takes
them and stores what they carry (`tests/integration/question-runner-wire-e2e.test.ts`).

## What is still true and was not fixed

- **The device door does not park.** A master's ask on an issue writes the question and leaves the
  issue's status alone. Parking it would strand the issue: `answer-resume` dispatches nothing when a
  box has registered to read the answer back, so nothing would ever move it out of `needs_info`.
  Until the box reports its own resume, a master's question on an issue shows on the issue's row
  and panel while the status says whatever the master left it at.
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
