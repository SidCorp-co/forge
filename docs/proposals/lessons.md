# Lessons: Forge learns from every correction and stops to ask when a lesson confuses

**Removed when:** REQ-50's eight criteria hold a counting verdict. After that, what holds is the code:
`packages/contracts/src/lessons.ts`, `packages/core/src/lessons/`, and migration 0510.

Requirement REQ-50 r2, BC-1..9. The owner said, 2026-10-21: "learn, but when using it you find a
confusion, report it so it is handled at once ... without learning, the same errors repeat, which is
very annoying for users, and the agents stay dumb". And ruled, 2026-10-23 (REQ-50 r2 BC-9, REQ-33
BC-9): lessons are internal to Forge. Agents and core read them, no screen shows a lesson, a
confusion or the monthly record to a person, and no person is asked to approve, reject, edit, retire,
keep or decide one.

It builds on the steward runtime (`docs/proposals/steward-agent.md`). Owner rules it keeps: agents act
and core never decides; gate as little as possible; a page is properties plus short rows; a refusal
names what was wrong; models go only through the gateway.

## 1. Correction sources (BC-1)

A correction is one row in `corrections`: the item it corrects, the reason as said, who said it and
with what agency, and the source. One row per source event, by a unique `(source, source_ref)`, so a
retried delivery never doubles it. A return or rejection with no reason is not a correction.

| Source | Recorded where | Item |
|---|---|---|
| `mockup_returned`, `mockup_accepted` (a reason given) | The `lessons-corrections` consumer of `mockup.transitioned`. `TRANSITION_EVENTS` gains `mockup: [accepted, returned]`, and the event carries the kernel move's reason and actor. The mockup's key is read as a `MockupView` through a lessons port, so nothing reaches into the mockups module's tables, which ISS-600 is rewriting. | The mockup (`MK-n`) |
| `suggestion_rejected` | `suggestions/service.ts:rejectSuggestion`, in its own transaction | The suggestion, keyed by its target |
| `design_returned` | `workflows/design-record.ts:recordDecision` on a `return` | The workflow |
| `revision_returned` | `requirements/service.ts:returnRevision` | The requirement (`REQ-n`) and its area |
| `verdict_failed` | `issues/criteria/verdict-record.ts:recordVerdict` on a `fail` with a reason | The issue (`ISS-n`) and the criterion |
| `chat` | The `lessons-chat` consumer of `chat.replied` (below) | The conversation and the assistant message corrected |

**Chat.** A person's message is a correction candidate only when it follows an assistant turn in a
project chat. `assistant/turn-lessons.ts:noteTurnLessons` emits `chat.replied` (ids only) when that turn is stored.
The consumer asks the fast model, through the gateway, whether the reply corrects the assistant: a
yes/no, a confidence, and one sentence saying what was wrong. It keeps the correction only at
confidence 0.7 or above (`CHAT_CORRECTION_THRESHOLD`). No screen shows a kept correction. A gateway
miss leaves the message as it is and logs the miss. The message never becomes a correction because
the model was unreachable.

## 2. Where a lesson lives (BC-2, BC-3, BC-7)

The lesson's lifecycle lives in `lessons`. Its text reaches agents through project knowledge.

- **`lessons`** holds: the number (`L-n`, per project), one sentence, a scope, and a status moved only
  by the kernel. Scope is one of `project`, `area` (a requirement area) or `item_kind` (`requirement`,
  `workflow`, `mockup`, `suggestion`, `issue`, `chat`). The machine `lesson` runs proposed → approved |
  rejected, approved ⇄ held, and approved | held → retired. It also holds `applied_count`,
  `last_applied_at`, `superseded_by`, the reason it was rejected or retired, and the check issue.
- **Provenance** is the corrections linked to it (`corrections.lesson_id`).
- **Knowledge.** On approval, the lesson writes a knowledge entry `lesson-<n>` of a new kind, `lesson`,
  with `injection: always` and metadata `{lessonId, scope}`. On hold or retirement the entry turns to
  `injection: none`. A proposed or rejected lesson has no entry, so no agent can read an unapproved
  lesson. The knowledge doors refuse a write to a `lesson` entry, `KNOWLEDGE_LESSON_OWNED`, so the one
  way to change one is the steward's decision.
- **Injection.** The generic "Project rules" block leaves `lesson` entries out. A separate "Lessons"
  block renders the scoped ones in four places:
  - the job preamble (`prompt/facts/resolve.ts`);
  - the checkout orientation (`prompt/checkout-orientation.ts`), which every master and box run reads;
  - the assistant's system prompt (`assistant/external-chat.ts`);
  - the steward's turn prompt (`steward/lessons-block.ts`).

  Each agent receives the `project` lessons, the `item_kind` lessons for the kinds it produces, and
  the `area` lessons for its subject's area. An agent with no subject gets every `area` lesson,
  labelled with its area.
- **Retirement (BC-7).** The steward retires a lesson in two cases, each with its reason in the
  kernel's record of the move: a lesson superseded by another, retired when its replacement is
  approved (`Superseded by L-n.`), and a lesson neither applied nor approved in 30 days, retired by
  the lessons pass (`gather.ts:retirementsDue`). Retiring keeps both the row and its knowledge entry,
  out of every prompt.

**Who proposes (BC-2).** The steward's lessons pass (`steward/lessons-pass.ts`, every
`LESSONS_PASS_MS`, only where the steward is on) reads the project's corrections that are unlinked
and not dismissed, alongside its proposed and approved lessons. It asks the fast model to do two
things:
- link each correction that repeats an existing lesson;
- group the rest. Two or more similar corrections become a proposed lesson, authored by the steward
  account, with a sentence, a scope, the links to its corrections and, where it replaces one, the
  lesson it supersedes.

**Who decides (BC-2).** The same pass settles each proposal (`steward/lessons-review.ts`). It asks
the fast model to check the lesson against the corrections it came from, the approved lessons, and
the agreed or accepted requirements and approved designs in its scope (`steward/lessons-scope.ts`).
The steward account, which holds `suggestions.approve`, then approves it, edits and approves it, or
rejects it, each with a reason the kernel keeps. Where the model gives no usable answer, or the
decision is refused, the proposal stays proposed, is named in the log, and is tried on the next pass:
nothing is approved by default. No person reviews it. This pass is not a gateway turn: a steward run
is about one item, and this pass is about the whole project.

## 3. Applied lessons per output (BC-4)

`lesson_applications` holds one row per lesson per output: the output's kind (`chat_message`,
`steward_run`, `job`, `issue`) and ref, the agent, and when. Each application can be marked wrongly
applied once.

- The Lessons block tells every agent to end an output a lesson shaped with the line
  `Lessons applied: L-3, L-7`.
- Core reads that line out of the assistant's stored reply and the steward run's final text.
- A run or master records it with `POST /api/projects/:id/lessons/applied
  {lessons, output:{kind, ref}}`.
- A number that is not an approved lesson is refused by name (`LESSON_NOT_APPLICABLE`), never
  recorded.
- An agent that finds one wrongly applied reports a `wrongly_applied` confusion naming the output in
  `other.ref` (section 4). That marks the recorded application wrong in the same transaction, and a
  confusion naming an output with no recorded application is refused by name.

## 4. Confusion goes to the steward (BC-5)

`lesson_confusions` holds:
- the kind: `conflict` (with another lesson), `contradicts` (a requirement or design, named by key),
  `unclear`, or `wrongly_applied`;
- both sides, each in one sentence;
- the recommended resolution: `keep`, `edit` with a new sentence, or `retire`;
- who raised it and when, who settled it and when, and the settlement.

- **Report.** Agents report one with `POST /api/projects/:id/lessons/:n/confusions` (`project.write`).
  A steward run reports one through its door tool `steward_raise_lesson_confusion`. The Assistant
  reports one with `forge_lesson_confusion`, which goes straight to the store: no confirm card holds
  it, since no person agrees to it (`assistant/agreement/write-rule.ts`). The Lessons block says:
  stop, do not guess, report it, and go on without that lesson.
- **Hold.** Raising moves the lesson approved → held in the same transaction, and its knowledge entry
  turns to `injection: none`. From that moment no prompt carries it. A lesson that is already held
  takes the new confusion beside the open one.
- **Settle.** The lessons pass settles each open confusion (`steward/lessons-review.ts`): the fast
  model reads both sides, the recommendation and the requirements and designs in the lesson's scope,
  and the steward keeps the lesson, edits it (its own sentence, or the recommended one), or retires it
  through `lessons/confusions.ts:decideConfusion`, with a reason the kernel keeps on the move. `keep`
  and `edit` move held → approved once no other confusion is open on it. With no usable answer the
  lesson stays held and the confusion is tried on the next pass. The time from report to settlement
  is the BC-8 figure. No Needs you decision, status row or page carries a lesson or a confusion.

## 5. A repeat becomes a check (BC-6)

When either condition below holds, the lessons pass files one draft issue, "Add a check: <sentence>".
It says the check can be a lint, a test or a screen probe, and lists the corrections. Its id is kept
on the lesson as `check_issue_id`, so it is filed once.
- The pass links a correction to a lesson approved before that correction was said (a repeat).
- A lesson's linked corrections reach 3.

The issue is a draft, so nothing dispatches it until it is opened.

## 6. Monthly figures (BC-8)

`lessons/month.ts:lessonsMonth` computes, for one project and one month:
- the corrections, by source;
- the lessons approved;
- the repeats;
- the confusions, each with its time to settlement, and the open ones counted from their report.

No route serves it and no screen shows it. No agent reads it yet either: BC-8's "records, for agents
to read" is met only once an agent's door or prompt carries it.

## 7. Migration 0510

It creates `corrections`, `lessons`, `lesson_applications` and `lesson_confusions`, and guards
`lessons.status` with the kernel (`forge_guard_status_column`). It seeds the event types
`mockup.transitioned` and `chat.replied`. The knowledge kind has no database CHECK, so `lesson` needs
no statement. Every table is new, so no existing row can fail a check.

It also widened `chat_proposals.kind` to `lesson_confusion` and added `lessons.retire_reason`,
`retire_proposed_at`, `kept_at` and `corrections.dismissed_at`. Since REQ-50 r2 no code writes any
of them: the CHECK still admits the kind (`db/schema-chat-proposals.ts`), and `kept_at` still
restarts the unused clock where a row holds one. Dropping them is a migration of its own.

## Honest costs

- **A gateway call on every chat reply.** Each person's message after an assistant turn is read by
  the fast model to decide whether it corrects the answer. A busy chat pays one small call per reply,
  and a missed correction (confidence under 0.7) is never kept.
- **A steward call every ten minutes per project with unheld corrections.** The grouping is a model
  judgement; a grouping that reads two corrections as one point proposes a lesson nobody meant, and
  only the steward's own review, a second model call per proposal, catches that. No person does.
- **A model settles every lesson.** Each proposal and each confusion costs one fast-model call per
  pass until it is settled, and a wrong settlement reaches every prompt in its scope until an agent
  reports a confusion about it.
- **Every prompt grows.** Each approved lesson is one more line in the run preamble, the checkout
  orientation, the assistant's and the steward's prompts. Retiring unused lessons is the only brake.
- **A held lesson is absent until the steward settles it.** A confusion withdraws the lesson from
  every prompt at once, so the error it fixed can come back while the gateway is down and the
  confusion waits for the next pass.
- **Agents report what they applied.** The `Lessons applied:` line is the agent's own claim; a lesson
  that shaped an output without being named is never counted, and an unused one may be retired.
