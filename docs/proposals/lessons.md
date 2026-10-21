# Lessons: Forge learns from every correction and stops to ask when a lesson confuses

**Removed when:** REQ-50's eight criteria hold a counting verdict. After that, what holds is the code:
`packages/contracts/src/lessons.ts`, `packages/core/src/lessons/`, and migration 0510.

Requirement REQ-50 r1, BC-1..8. The owner said, 2026-10-21: "learn, but when using it you find a
confusion, report it so it is handled at once ... without learning, the same errors repeat, which is
very annoying for users, and the agents stay dumb".

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
confidence 0.7 or above (`CHAT_CORRECTION_THRESHOLD`). Each kept chat correction is always shown to
the person, as a line under their own reply ("Kept as a correction · Not a correction"), and the
person can say it is not one. That dismisses it, and a dismissed correction never feeds a lesson. A gateway miss leaves
the message as it is and logs the miss. The message never becomes a correction because the model
was unreachable.

## 2. Where a lesson lives (BC-2, BC-3, BC-7)

The lesson's lifecycle lives in `lessons`. Its text reaches agents through project knowledge.

- **`lessons`** holds: the number (`L-n`, per project), one sentence, a scope, and a status moved only
  by the kernel. Scope is one of `project`, `area` (a requirement area) or `item_kind` (`requirement`,
  `workflow`, `mockup`, `suggestion`, `issue`, `chat`). The machine `lesson` runs proposed → approved |
  rejected, approved ⇄ held, and approved | held → retired. It also holds `applied_count`,
  `last_applied_at`, `superseded_by`, a retirement proposal, and the check issue.
- **Provenance** is the corrections linked to it (`corrections.lesson_id`), shown with each lesson.
- **Knowledge.** On approval, the lesson writes a knowledge entry `lesson-<n>` of a new kind, `lesson`,
  with `injection: always` and metadata `{lessonId, scope}`. On hold or retirement the entry turns to
  `injection: none`. A proposed or rejected lesson has no entry, so no agent can read an unapproved
  lesson. The knowledge doors refuse a write to a `lesson` entry, `KNOWLEDGE_LESSON_OWNED`, so the one
  way to change one is a decision here.
- **Injection.** The generic "Project rules" block leaves `lesson` entries out. A separate "Lessons"
  block renders the scoped ones in four places:
  - the job preamble (`prompt/facts/resolve.ts`);
  - the checkout orientation (`prompt/checkout-orientation.ts`), which every master and box run reads;
  - the assistant's system prompt (`assistant/external-chat.ts`);
  - the steward's turn prompt (`steward/prompts.ts`).

  Each agent receives the `project` lessons, the `item_kind` lessons for the kinds it produces, and
  the `area` lessons for its subject's area. An agent with no subject gets every `area` lesson,
  labelled with its area.
- **Retirement (BC-7).** The steward's daily lessons pass proposes retirement in two cases: a lesson
  superseded by another approved one, and a lesson neither applied nor approved in 30 days. Each
  proposal has its reason. A person retires the lesson or keeps it, and keeping it restarts the
  clock. Retiring keeps both the row and its knowledge entry.

**Who proposes (BC-2).** The steward's lessons pass (`steward/lessons-pass.ts`, every
`LESSONS_PASS_MS`, only where the steward is on) reads the project's corrections that are unlinked
and not dismissed, alongside its proposed and approved lessons. It asks the fast model to do two
things:
- link each correction that repeats an existing lesson;
- group the rest. Two or more similar corrections become a proposed lesson, authored by the steward
  account, with a sentence, a scope and the links to its corrections.

A person approves it (optionally editing the sentence or scope), edits it, or rejects it with a
reason, holding `suggestions.approve`, the same as for a suggestion. This pass is not a gateway turn:
a steward run is about one item, and this pass is about the whole project.

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
- The assistant message shows the lessons it applied as a line under it. The lesson's page lists
  every application.
- `POST …/lessons/applications/:id/wrong {reason}` marks one wrongly applied. That raises a
  `wrongly_applied` confusion (section 4).

## 4. Confusion becomes a Needs you decision (BC-5)

`lesson_confusions` holds:
- the kind: `conflict` (with another lesson), `contradicts` (a requirement or design, named by key),
  `unclear`, or `wrongly_applied`;
- both sides, each in one sentence;
- the recommended resolution: `keep`, `edit` with a new sentence, or `retire`;
- who raised it and when, who decided it and when, and the decision.

- **Raise.** Agents raise one with `POST /api/projects/:id/lessons/:n/confusions` (`project.write`).
  The steward raises one through its door tool `steward_raise_lesson_confusion`. The Assistant
  raises one with `forge_lesson_confusion`; it withdraws the lesson from every prompt, so it is held
  as a confirm card like every chat write (`lesson_confusion`, REQ-30 BC-4) and raised as the person
  once they record it. The Lessons block says: stop, do not guess, raise it, and go on without that
  lesson.
- **Hold.** Raising moves the lesson approved → held in the same transaction, and its knowledge entry
  turns to `injection: none`. From that moment no prompt carries it. A lesson that is already held
  takes the new confusion beside the open one.
- **Decide.** `POST …/lessons/confusions/:id/decide {resolution, sentence?}` (`suggestions.approve`).
  `keep` moves held → approved. `edit` rewrites the sentence and its entry, then approves. `retire`
  retires the lesson. The time from raise to decision is the BC-8 figure.
- **Needs you.** `development/needs-you-lessons.ts:lessonDecisionsFor` folds the lessons into the one
  Needs you read under topic `lesson`, entity `lesson`: each open confusion is an `answer` decision
  whose question carries both sides, its answers Keep, Edit as recommended (the raiser's sentence) and
  Retire through `lesson.confusion`, the raiser's recommendation marked; each proposed lesson is an
  `approve` decision (`lesson.approve`, `lesson.reject` with a reason); and each retirement proposal is
  an `approve` decision whose ✓ retires with the rule's own reason (`lesson.retire`) beside Keep
  (`lesson.keep`). Only a viewer holding `suggestions.approve` is offered them. What waits is read
  by `lessons/waiting.ts:lessonsWaiting`, one statement each across every project the person sees. The Lessons page leads
  with the same open confusions.

## 5. A repeat becomes a check (BC-6)

When either condition below holds, the lessons pass files one draft issue, "Add a check: <sentence>".
It says the check can be a lint, a test or a screen probe, and lists the corrections. Its id is kept
on the lesson as `check_issue_id`, so it is filed once.
- The pass links a correction to a lesson approved before that correction was said (a repeat).
- A lesson's linked corrections reach 3.

The issue is a draft, so nothing dispatches it until a person opens it.

## 6. Monthly read (BC-8)

`GET /api/projects/:id/lessons/month?month=YYYY-MM` reads, for one month:
- the corrections, by source;
- the lessons approved;
- the repeats;
- the confusions, each with its time to decision, and the open ones counted from their raise.

The Lessons page's "Month" view draws it.

## 7. Migration 0510

It creates `corrections`, `lessons`, `lesson_applications` and `lesson_confusions`, and guards
`lessons.status` with the kernel (`forge_guard_status_column`). It seeds the event types
`mockup.transitioned` and `chat.replied`. The knowledge kind has no database CHECK, so `lesson` needs
no statement. Every table is new, so no existing row can fail a check.

## Honest costs

- **A gateway call on every chat reply.** Each person's message after an assistant turn is read by
  the fast model to decide whether it corrects the answer. A busy chat pays one small call per reply,
  and a missed correction (confidence under 0.7) is never kept.
- **A steward call every ten minutes per project with unheld corrections.** The grouping is a model
  judgement; a grouping that reads two corrections as one point proposes a lesson nobody meant, and
  only the person approving it catches that.
- **Every prompt grows.** Each approved lesson is one more line in the run preamble, the checkout
  orientation, the assistant's and the steward's prompts. Retiring unused lessons is the only brake.
- **A held lesson is absent until someone decides.** A confusion withdraws the lesson from every
  prompt at once, so the error it fixed can come back while the decision waits in Needs you.
- **Agents report what they applied.** The `Lessons applied:` line is the agent's own claim; a lesson
  that shaped an output without being named is never counted, and an unused one may be retired.
