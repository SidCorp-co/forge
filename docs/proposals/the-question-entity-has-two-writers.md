# The question entity has two writers, and only one of them creates a question

Measured 2026-09-23 against `main` at `710ab641` and the installed plugin at `3.36.262`. Written
because the split runs across a repository boundary this repo cannot gate, and the way it was found
was an owner staring at an empty panel for nineteen hours (ISS-1210).

## What core owns

The entity, its two doors and everything that reads it:

- `packages/core/src/questions/` — `write.ts` (`askQuestion`, `askParkQuestion`, `answerQuestion`),
  `read.ts` (`projectQuestionsFor`, `readQuestionsForIssue`, `registerWaiter`, `waiterFor`),
  `routes.ts`, `screen.ts`, `stop.ts`, `origin.ts`, `protections.ts`
- `POST /api/questions` on a personal access token, in `questions/routes.ts`
- `POST /api/devices/me/questions` and `GET /me/questions/:questionId?runId=` on a device pairing,
  in `devices/pool-routes.ts`
- two screens: the issue decision panel (`web-v2` `features/questions/components/decision-panel.tsx`)
  and the Agents screen's Questions tab (`features/agents/components/questions-pane.tsx`)
- two sweeps that key on a question row: `jobs/park-deadline.ts`'s `parkedOnAHuman`, which exempts a
  processless human park from the residency reaper, and `reapUnansweredParks`, which is that park's
  replacement clock

`projectQuestionsFor` filters on project and status and never on issue, which is why a question
carrying no issue — a box's own — reaches the Questions tab with no separate read path.

## The three writers, and what each one produces

| Writer | Where it lives | Creates a question row |
|---|---|---|
| `mintParkQuestion` → `askParkQuestion` | `packages/core/src/issues/park-question.ts` | yes, on a park to the autonomous question status made on an agent or device credential |
| `forge-runner question ask` → `transport::questions::ask` | `packages/runner/crates/forge-runner/src/cmd/question.rs` | yes, on the box's device pairing (added by ISS-1210) |
| `forge record question` | `github.com/SidCorp-co/forge-plugin`, `plugin/` | **no** — it writes a `forge-record: question` comment and nothing else |

The third is the half this repo cannot gate. Its record reads correctly to a human in the thread,
the run parks, the status moves and nothing fails; only the screen the person was pointed at is
empty. That is filed on the `forge-plugin` project and named here so the next reader does not
rediscover it from an empty panel.

## What binds the two halves that ARE here

The runner and core do not import each other, so the body the box puts on the device door is pinned
as a file both suites read: `packages/runner/crates/forge-runner-core/assets/question-ask-wire.jsonl`.
The runner asserts it sends exactly those bodies (`cmd/question.rs`); core asserts the door takes
them and stores what they carry (`devices/pool-routes-questions.test.ts`). A field renamed on one
side and not the other goes red in both, rather than on a box where the question never appears. The
same shape already binds the master-limit report through `assets/master-limit-wire.json`.

## What is still true and was not fixed

`packages/runner/crates/forge-runner-core/src/runner/blocked.rs` — `arm_bounded` and
`park_for_human` — still has no caller outside its own tests, so no run declares itself parked on a
person. `question ask` deliberately does not park the run: declaring a park changes what the
daemon's recovery and sweeps do with it, which ISS-1210 did not ask for and reproduced nothing
about. While that stands, `parkedOnAHuman` matches nothing on a box, and both of the sweeps above
have an empty subject set. Whether that is a defect or merely an unused defence is unproven either
way, and repairing a sweep against a failure nobody has reproduced would be a guess.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| A third route to the same entity | A question can now be created three ways, and a reader asking "how did this row get here?" has three answers to check instead of two. The box gets a route it did not have; whoever debugs a stray question pays the widened search |
| The wire is pinned in a file, so a field is renamed twice | `question-ask-wire.jsonl` has to be edited whenever the ask body changes, and a reviewer who edits it to make a suite green has silently moved the contract. What it buys is that the runner and core cannot drift apart in silence; the price is a fixture that looks like test data and is not |
| `question ask` mints a run identity when none is given | A box that asks twice about the same work leaves two unrelated waiter rows, and nothing correlates them. That is the price of a verb a master can run with no run in hand; a caller that has a run id passes `--run` and pays none of it |
| The verb asks and does not park | The run keeps its process and its slot while a person thinks, so a box asking often holds work open. Wiring the ask to `park_for_human` would release the slot and is the additive change this one leaves undone |
| Writing the split down does not close it | This document has to be deleted or rewritten the day `forge record question` starts creating the entity, and until then it is a second place where the coupling is described. The alternative was leaving it discoverable only from an empty panel |
