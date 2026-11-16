# Policy mechanisms that still force agents become a door, a card and a signal

**Removed when:** every row below is converted or settled as staying, by the issues that take them;
until those are filed, ISS-1251 carries this file, and the change that settles the last row deletes
it.

ISS-1251's design (owner, 2026-11-16) and `VISION: kernel-hard-policy-soft` say that beyond the
kernel, an agent is given doors it calls when it judges it needs them, a card that teaches when and
how, and a signal that shows what it did. Core does not take a step on its behalf, fill in its work,
rewrite or block its reply, or refuse a choice the project's policy leaves to it. The kernel (job,
session, run, state, transition, evidence, retry, escalation), contract shapes and safety bars
(secrets, credentials, leaks to a user) still refuse by name.

ISS-1251 swept the live mechanisms. Builder D's inventory is the full list. These were converted
in that batch:

- the memory code-block refusal (now the `CODE_BLOCK_LONG` warning);
- the debts door's refusal of a red rated high (now the `RED_RATED_HIGH` warning,
  `cleanup/rules.ts:debtWarnings`);
- the stop gate's dirty-tree refusal (now journalled, `runner-core/src/stop_gate.rs:decide`).

This file holds every policy mechanism the batch did not convert, with why it waited and what
converting it means. Paths are under `packages/core/src/` unless named.

## Why each waits

Two reasons recur.

- **The requirement leads** (`VISION: requirement-leads-delivery`). Most of these mechanisms are a
  requirement's criterion as written: REQ-89 BC-2, REQ-76, REQ-41 BC-3, REQ-32 BC-6, REQ-75, REQ-90.
  Converting one without first revising its requirement would leave the code and the requirement
  disagreeing, which is drift. The revision is a Product act on the tracker. It comes first, then
  the conversion.
- **A gate a person set is that person's policy.** Where a project's owner chose enforcement (a gate
  profile default, `delivery.fast: false`, a deciders rule), the refusal is the project's own policy
  and stays until the owner chooses otherwise. Changing a default every project inherits is the
  owner's decision. This file recommends; it does not decide.

## Curation of what agents write (REQ-89 BC-2)

| Mechanism | Forces | Conversion |
|---|---|---|
| `knowledge/subject-held.ts:subjectHeldRefusal` (`KNOWLEDGE_SUBJECT_HELD`) | a similarity score of 0.85 or above refuses a new knowledge slug | write it, answer with the near entries under `similar` and a warning, and show the near pair on the knowledge page; the card of `PUT …/knowledge/:slug` teaches "when a near entry exists, update it with `updates`" |
| `memory/write-service.ts:landingOfCuratedWrite` (cosine auto-land) | core lands a new note on another entry's ref and replaces that entry's body | write the note as its own entry, answer with `similar`, and let the writer or the steward's delta curator merge |
| `knowledge/provenance.ts` (`KNOWLEDGE_PROVENANCE_MISSING`) | a knowledge entry without `readWhen`, `source` and `recheckWhen` is refused | store it, warn, and list it as owing its answers, as memory already does (`CURATION_OWED`) |

Signal: the door-use read counts the warnings and the near pairs left unmerged.

## Gates whose standard default enforces an agent's process choice (REQ-76)

| Mechanism | Forces | Conversion |
|---|---|---|
| `issues/create-service.ts:refuseChatDoorFiling` (`CHAT_FILES_FEEDBACK_NOT_ISSUES`, gate `chat_files_issue`) | which door a chat agent files through | standard default `advise`: the filing is taken, the gap recorded on it, and the card of the feedback door teaches when a chat finding is feedback |
| `@forge/contracts/gate-profiles.ts:GATE_CATALOG`: `issue_before_code`, `feedback_triage`, `breakdown`, `issue_ready`, `requirement_checked`, `contract_wait` (standard `enforce`) | process steps before a move | standard `advise` for each, recording the gap on the move as `yolo` already does; `strict` keeps `enforce`, the owner's control |
| `questions/owed.ts:owedBlockerOf` (`QUESTION_AGENT_DECIDES`) | refuses an agent asking a person what policy says the agent decides | take the ask, answer with a warning naming the decision-authority rule, and show agent asks per project, so routine asks can be seen and taught away (REQ-90 BC-12, BC-14) |

Permission and approval gates are a person's control and stay. So does `FAST_DELIVERY_OFF`, a
project owner's setting.

## Core holds, cuts or rewrites an agent's reply (REQ-41 BC-3, REQ-32 BC-6, REQ-75)

| Mechanism | Forces | Conversion |
|---|---|---|
| `messaging/cells.ts`, `messaging/doors.ts:DOORS` (the message contract), and `messaging/text-rules.ts` (`NO_EMPTY_PROMISE`, `NO_DEVELOPER_DETAIL`, `ISSUE_LINK_SHAPE`, `NO_ROOM_BROADCAST_*`) | each door's phrasing rules: a refused reply, a corrective retry, then a fallback | a `check_reply` door the agent calls on its draft, returning the same findings; the reply goes out as the agent sends it, and the findings are kept beside it as a visible verdict. `NO_REDACTED_SECRET` stays a refusal (safety); `SINGLE_LINE` and `NO_OPTION_LINE` stay as the option-rendering contract |
| `messaging/reply-opening-rule.ts:withoutFalseOpening` (`OPENS_WITH_ITS_ANSWER`) | strips the reply's opening | a `check_reply` finding, never a rewrite |
| the claim rules: `messaging/figures-rule.ts`, `messaging/status-claims-rule.ts`, `messaging/creation-claims-rule.ts`, `ui-claims`, `progress` and `claim` rules | holds a reply whose figures, dates, status or acts it cannot ground | keep each as a check the agent calls and a verdict shown on the reply ("2 figures not grounded"), since grounding serves `state-never-lies` toward the reader; the hold goes. Described today in `docs/proposals/chat-visual-answers.md` |
| `assistant/screened-reply.ts:screenedTurnReply`, `messaging/reply-marks.ts:cutHeldSentences`, `repairIssueLinks`, `assistant/confab.ts:correctFalseClaims` | cuts refused sentences, appends a notice, rewrites links, appends "Correction:" lines | removed with the screen; what was found is shown as the reply's verdict |
| `assistant/chat-room/escalation-synthesis.ts:synthesizeViaBao`, `ESCALATION_FALLBACK_REPLY`, the held notice in `conversations/conversation-agent-bridge.ts` | re-voices or replaces a reply with a canned line | removed; a reply that is not sent is shown to its asker as held, with why |
| `comments/screen.ts:screenAgentComment` (`STATUS_MATCHES_THE_ROW` on comments) | refuses a comment stating a status other than the row's | a warning on the write and a mark on the comment |
| `assistant/agreement/held-language.ts` | refuses a held write whose prose is not the project's language | a warning, as release notes already answer |

The reply screens of `support/**` are ISS-1250's. They follow the same conversion when that batch
lands, keeping their secret and leak half.

## Steps core takes on the agent's behalf

| Mechanism | Does | Conversion |
|---|---|---|
| `issues/draft-release-notes.ts:draftMissingReleaseNotes` | fills a missing release note from the title | the release shows the note as missing, and the card of the issue `PATCH` teaches writing it before `awaiting_release` |
| `issues/criteria/close-verdicts.ts:recordCloseVerdicts` | writes `pass` verdicts at close for the closer | borderline evidence: decide with the release counting it feeds; the closer records its own verdicts, taught by the issue-flow card |
| `intake/service.ts:registerIntakeAssistant` (fills draft gaps, refuses by value, suggests duplicates and triage) | fills and triages a draft | the suggestions stay as suggestions shown on the draft; the fill and the refusal go |
| `memory/extraction.ts:registerMemoryExtraction`, `memory/consolidation.ts:runConsolidationSweep`, `memory/reconcile.ts` | a model writes, rewrites or archives memories | folded into the steward's delta curator (ISS-1251 §4), every edit an ADD, UPDATE, MERGE or RETIRE on the record |
| `steward/door-prepare.ts:PREPARE` | the steward writes criteria for the author | offered to the author as a suggestion |
| `cleanup/gate-debt.ts:recordGateDebt` | files debt with a guessed rating | file it unrated, owed a rating by the issue's holder |
| `requirements/room-settle.ts:roomSettleWriter`, `suggestions/kept-preview.ts:writeKeptPreview` | writes a revision, issue or criteria with fixed text | the agent writes them through the same doors, taught by their cards |
| `onboarding/first-requirements.ts:registerFirstRequirementsCase` | starts a BA turn nobody asked for | offered to the person as the next step |
| `feedback/loop-check.ts:sweepResolvedFeedback` | verifies feedback by its ship outside strict | borderline evidence: the reporter's confirm stays the verdict; the sweep proposes it |
| `assistant/tools/memory-note-gate.ts:memoryNotePreCall` | refuses an assistant note that restates the person or duplicates one | warn and answer with `similar` (builder D may take this in ISS-1251) |

## Order

1. The requirement revisions: REQ-89 BC-2, REQ-76's standard defaults, REQ-41 BC-3, REQ-32 BC-6,
   REQ-75's reply rules, REQ-90 BC-12. One Product round, the owner deciding the gate defaults.
2. Curation and the gate defaults. They are small, and each is a warning in place of a refusal.
3. The reply screen. It is the largest, and `check_reply` must exist before the hold goes.
4. The automatic steps, each with its feature.

## Honest costs

| Cost | Who pays it |
|---|---|
| A reply the screen would have held goes out with its findings shown beside it, so a reader can see an ungrounded figure the screen used to stop | the reader, until the teaching and `check_reply` catch it; the verdict on the reply is what makes it visible |
| Standard projects no longer stop a process step, so work can open or land without a breakdown or a checked requirement, recorded as a gap on the move | the project, which reads those gaps; an owner who wants the stop sets `strict` |
| Near-duplicate knowledge and memory accumulate until the curator merges them | the steward's lessons pass and the budgets that trigger it |
| Release notes, criteria and drafts are no longer filled for the agent, so a step an agent skips shows as missing, not as a weak fill | the release reader, who sees the gap, and the agent's card, which is taught better from it |
| Every row waits on a requirement revision first, so this file lives across several batches | the Product round that revises them |
