# ISS-1251's teaching inventory: every text read, each pile against its cap, every forcing mechanism

**Removed when:** ISS-1251's criterion 12 is judged on this file and the last row of
`teach-not-force-mechanisms.md` is settled; the change that deletes that proposal deletes this file.

ISS-1251's close cited "Builder D's inventory", which no comment, attachment or file held. This file
is that inventory, kept in the repo. It has three parts:

- each pile against its cap;
- every text read for the issue, with what became of it;
- every forcing mechanism found, converted or written up.

Sizes are characters, measured at the head of `fix/iss1251-r2-render` on 2026-11-16. The caps are
the code's own constants, and each size is the output of running the code that composes the pile.
"Live" figures are forge-dev's `GET /api/projects/<forge>/metrics/piles` at 4efa1e10 (0.4.0-dev.698).

## 1. Each pile against its cap

| Pile | Cap (constant) | Before | Now | Carried | Due |
|---|---|---|---|---|---|
| Tier-0 map, bot | 2 500 (`capability-cards.ts:TIER0_MAP_MAX_CHARS`) | 1 606 live | 1 689 | 51 of 51 cards | no |
| Tier-0 map, master | 2 500 | 2 453 live | 2 493 | 128 of 128 | no; 7 characters to spare |
| Tier-0 map, run | 2 500 | 1 501 live | 1 555 | 68 of 68 | no |
| Tier-0 map, person | 2 500 | — | 2 497 | 15 of 77 | **yes**: merging owed (the cards builder's families) |
| Lessons map, forge's runs | 1 200 (`lessons/block.ts:LESSONS_MAP_MAX_CHARS`) | 1 085, naming 1 of 82 | 1 138, naming 8 of 82 | 8 of 82 | yes: 74 lessons owe a fold |
| Always-on knowledge, forge | 6 000 (`@forge/contracts/knowledge:ALWAYS_INJECT_MAX_CHARS`) | 9 468 live, 14 entries | unchanged | 14 | **yes**, 3 468 over |
| Skill always-on part, `forge-message-shape` | 1 024 (`@forge/contracts/door-use:SKILL_ALWAYS_ON_MAX_CHARS`) | 527 | 527 | 1 | no |
| Skill always-on part, `forge-product-map` | 1 024 | 763 | 763 | 1 | no |
| Skill always-on part, `forge-skills` | 1 024 | 506 | 506 | 1 | no |
| Skill always-on part, `forge-master` (runner) | 1 024 | 507 | 507 | 1 | no |

Measured beside the piles. These texts have no cap constant, so they are listed without a "due":

| Text | Before | Now | What changed |
|---|---|---|---|
| `forge-master` skill, whole (read every master pass) | 33 699 | 9 201 | its method moved to core: the `forge-master` guide, the `dispatch` guide and the master map |
| `forge_support` description | about 27 000 | 12 047 | each act's entry is its card's purpose |
| Pipeline rules (`pipeline-rules` fact) | 18 892 | 15 892 | the door bullets are rendered from the cards |
| Drive rules (`drive-rules.ts:DRIVE_RULES_TEXT`) | 10 017 | 11 816 | the issue's doors' cards are now carried, where two bullets restated part of them |
| Doors with a card | 228 at 4efa1e10 | 233 of 596 | carding is the cards builder's |

How each figure was read:

- The Tier-0 maps are `lib/door-catalog.ts:tier0Map` over `mcp/door-catalog.ts:servedDoorCatalog`, unranked.
- The lessons map is `lessons/block.ts:lessonsMapOverflow`, run on forge's 85 approved lessons as
  `GET /api/projects/<forge>/knowledge/<slug>` serves them, the run audience reaching 82.
- A skill's always-on part is its frontmatter `description`, as `metrics/piles.ts:readPiles` measures it.

A pile past its cap is due for consolidation: folding what holds into the teaching that owns it, or
retiring it. It is never cut (`metrics/piles.ts`). The steward opens the item; nothing here truncates.

## 2. Every text read, and what became of it

"Rewritten" means changed by ISS-1251 in round 1, 2 or 3. "Rendered" means its door teaching now
comes from cards. "Deleted" means it is gone. "Still true" means it was read against the code and the
cards and kept as it stands. Round 3 read whole every text earlier rounds had left unread, for
forcing: a line that teaches stays, and a mechanism behind it that refuses an agent's choice or takes
a step for it is converted or written up (§3). Paths are under `packages/core/src/` unless named.

### Prompts, briefs and skills

| Text | Path | Status |
|---|---|---|
| Room brief | `support/prompt.ts`, `support/room-conduct.ts` | rewritten (round 1): a map of situations rendered from the room acts' cards, detail in the room guide |
| Room agent's guide | `support/room-guide.ts`, `guides/room-agent-guide.ts` | rewritten (round 1) |
| `forge_support` description | `support/tool.ts` → `support/tool-description.ts` | rendered (round 2). The hand-written 27 KB is deleted. The 17 acts no card covers yet keep a one-line entry, which goes when their card lands (a build error otherwise) |
| Reply audit's tool text | `support/reply-audit/teach.ts` | rewritten (round 2): only the rubric, read off the contract, beside the card |
| Pipeline rules | `prompt/facts/registry.ts` (`pipeline-rules`) | rewritten (round 2). Park, `needs_info`, merge stamp and blocker bullets deleted; transition, merge and dependency cards rendered (`prompt/facts/issue-doors.ts`). Kept: kernel and conduct lines no door owns |
| Drive rules | `prompt/facts/drive-rules.ts` | rewritten (round 2): "verify a merge" and "a blocker releases you" deleted, the same cards rendered |
| Run tool reference | `prompt/facts/drive-rules.ts` (`DRIVE_TOOL_REFERENCE_TEXT`) | rewritten (round 1): reads only, pointing at the run's map and cards |
| Operating affordances table | `prompt/facts/registry.ts`, `prompt/facts/affordance-cards.ts` | rendered (round 1) from the REST cards |
| Run's map | `prompt/door-map.ts` | rewritten (round 1): Tier 0 from the cards |
| Lessons map | `lessons/block.ts` | rewritten (round 2): the frame spells the project path once and each situation once. Forge's map names 8 of 82 lessons where it named 1 |
| Checkout orientation (`CLAUDE.local.md`) | `prompt/checkout-orientation.ts` | rewritten (round 1); its lessons block shortened (round 2) |
| `forge-master` skill | `packages/runner/crates/runner-workspace/assets/forge-master-skill.md` | rewritten (round 2): role, goal, invariants and what a pass owes, plus pointers to the master map (`guides/doors.md?audience=master`), the cards and the guides |
| Its direct-mode section | same | deleted: the `dispatch` guide's Direct mode says it |
| Its run-declaration section | same | deleted: the `dispatch` guide's §5 and §6 say it |
| Its "what is yours" section | same → `guides/master-guide.ts` | moved to the `forge-master` guide. The paragraphs restating the transition, merge, dependency and question cards were deleted, and those cards render beneath it |
| Master nudge | `masters/pass-order.ts` | rewritten (round 1); read in round 2: still true. It restates no guide, which the composed-prompts test holds |
| Owed lines of a pass | `masters/owed.ts` | still true (read in round 2): its release-naming line is the one copy, and the guide's duplicate of it was dropped |
| Served skill `forge-product-map` | `packages/core/skills/forge-product-map/SKILL.md` | rendered (round 2): it names the knowledge write and search doors, whose cards replace the marker at seed |
| Served skill `forge-skills` | `packages/core/skills/forge-skills/SKILL.md` | still true: it names doors only in passing, and teaches skill authoring |
| Served skill `forge-message-shape` | `packages/core/skills/forge-message-shape/SKILL.md` | still true: message shape, no door teaching beyond one attribute write |
| Steward's lessons pass | `steward/lessons-pass.ts`, `steward/lessons-review.ts`, `steward/lessons-lifecycle.ts` | rewritten (round 1): delta curator, folds and piles |
| Steward's act prompts | `steward/prompts.ts` | read whole (round 3), kept: each act's method is teaching, and what the steward may not do is its token's grant. Its line "where you neither act nor ask, Forge asks whoever owes the act for you" teaches `steward/diagnosis-end.ts:endUnmovedDiagnosis`, a step core takes for the steward: written up (§3) |
| Assistant prompt layers | `assistant/prompt/base.ts`, `tools.ts` (together the `answering-as-the-assistant` guide), `identity.ts`, `linking.ts`, `await-reply-line.ts`, `issue-work-line.ts`, `door-web.ts`, `door-web-agent.ts`, `door-rocketchat.ts`, `door-ba.ts`, `door-ba-first.ts`, `door-widget.ts` | read whole (round 3), kept. The lines saying a reply or a figure is "refused" or "held" teach the reply screens below and stay true until those convert. `CHAT_WRITE_AWAITS_AGREEMENT` and `TURN_ORIGIN_REFUSED` are a person's agreement and stay. The BA layers teach `REQUIREMENT_PICTURE_NOT_DRAWN`: written up (§3). ISS-1250 (closed) owns the room's reply audit in `support/**`, which none of these is |
| Reply screens | `assistant/screened-reply.ts:screenedTurnReply`, `messaging/reply-marks.ts:cutHeldSentences` and `repairIssueLinks`, `assistant/confab.ts:correctFalseClaims`, `assistant/chat-room/escalation-synthesis.ts:synthesizeViaBao` | read whole (round 3). Each rewrites or replaces an agent's reply on its behalf: cuts held sentences and adds the held notice, points hash links at the web path, appends "Correction:" lines, re-voices an escalation and falls back to a canned line. Already written up (§3) under REQ-41 BC-3, REQ-32 BC-6 and REQ-75, unchanged: those revisions and the `check_reply` door come first |
| Held-language check | `assistant/agreement/held-language.ts:heldLanguageRefusal` | read whole (round 3), written up (§3) and kept: REQ-69 BC-10 says saved project text is in the project's language, and as a warning the person could agree a card in another language, so the revision comes first |
| Memory-note gate | `assistant/tools/memory-note-gate.ts:memoryNotePreCall`, `assistant/tools/forge-memory-note-tool.ts` | converted (round 3): a note that breaks a rule is written, the rule put before the tool's result (`run-turn-core.ts:PreCallNotice`) and shown in the transcript; the tool's description teaches the rules. `memory-note-gate.test.ts` goes red if the refusal comes back |

### Guides

| Guide | Path | Status |
|---|---|---|
| `forge-master` | `guides/master-guide.ts` | new (round 2), carrying the master's own acts with its doors' cards beneath |
| `ecosystem-inbox` | `guides/ecosystem-inbox-guide.ts` | rendered (round 2): its publishing steps point at the interface write and the version publish and decide cards, which now hold the commitments, kinds, `sourceRef`, scheme and refusal text. How a change is measured stays as prose |
| `issue-flow` | `guides/issue-flow-guide.ts` | rewritten (round 1): door cards rendered beneath |
| `what-is-an-issue`, `writing-an-issue`, `pipeline-and-issue-lifecycle` | `guides/issue-guides.ts` | rewritten (round 1) |
| `requirement-lifecycle` | `guides/requirements-guide.ts` | rewritten (round 1) |
| `workflow-design` | `guides/workflow-design-guide.ts` | rewritten (round 1) |
| `fast-delivery` | `guides/fast-delivery-guide.ts` | rewritten (round 1): the `RED_RATED_HIGH` warning |
| `conformance-and-verify` | `guides/conformance-guide.ts` | rewritten (round 1) |
| `agent-setup` | `guides/registry.ts` | rewritten (round 2): the master's row names `forge-master` |
| `room-agent` | `guides/room-agent-guide.ts` | rewritten (round 1) |
| `dispatch` | `guides/dispatch-guide.ts` | still true (read in round 2): it holds the direct mode and run declaration the skill restated, which `guides/master-guide.test.ts` pins |
| `runs-and-masters` | `guides/runs-guide.ts` | still true (read whole in round 3): it describes standing; the reapers it names are the kernel's run and session failure |
| `product-role` | `guides/product-role-guide.ts` | still true (read whole in round 3): no forcing; how much a person approves is the gate profile, a person's control |
| `project-settings-and-test-credentials` | `guides/registry.ts` | still true (read whole in round 3): `projectFacts` and a stale revision are refused as contract shapes |
| `issue-dependencies` | `guides/registry.ts` | still true (read whole in round 3): a `blocks` edge's hold is the kernel's; a mark takes the agent's word |
| `memory-and-knowledge` | `guides/registry.ts` | still true (read whole in round 3): the `issue`, `comment` and `job` rows being core's copies is a contract |
| `deploy-safety` | `guides/registry.ts` | still true (read whole in round 3): the production confirm is a person's control, a deploy sent once is safety |
| `attachments-and-uploads` | `guides/registry.ts` | rewritten (round 3): its summary and heading named a presigned URL where the issue and comment doors take a multipart file; no forcing |
| `module-taxonomy-migration` | `guides/registry.ts` | rewritten (round 3): the prompt section is named by the title it has; no forcing |
| `answering-as-the-assistant` | `guides/assistant-method-guide.ts`, composed from `assistant/prompt/base.ts` and `tools.ts` | read whole (round 3) with the prompt layers above |
| `records-and-comments` | `guides/records-guide.ts` | still true (read whole in round 3): `record-in-comment` refuses only a caller that declared it has a record route, a contract; the verdict refusals are evidence |
| `workflow-templates` | `guides/workflow-templates-guide.ts` | still true (read whole in round 3): every refusal is the design's template contract |
| `mockups` | `guides/mockups-guide.ts` | still true (read whole in round 3); `MOCKUP_QUEUE_FULL` written up (§3) |
| `release-tags` | `guides/release-tags-guide.ts` | still true (read whole in round 3): a merge pinned to its approved head is evidence |
| `script-schedules` | `guides/script-schedules-guide.ts` | still true (read whole in round 3): the read-only declaration refusals are safety, a script never writing production |
| `monitoring` | `guides/monitoring-guide.ts` | still true (read whole in round 3): the binding's contract, and an unauthenticated server refused as safety |
| `cleanup-audit` | `guides/cleanup-audit-guide.ts` | still true (read whole in round 3): `CLEANUP_RESULT_DISAGREES` is evidence |
| `suggestions` | `guides/suggestions-guide.ts` | still true (read whole in round 3); `SUGGESTION_REJECTED_BEFORE` and `SUGGESTION_QUEUE_FULL` written up (§3) |
| `feedback-triage` | `guides/feedback-guide.ts` | still true (read whole in round 3); `FEEDBACK_REPRODUCTION_EMPTY` written up (§3); `FEEDBACK_ISSUE_ACT_FORBIDDEN` refuses a person's web session, not an agent; the loop check and intake were already listed |
| `qa` | `guides/qa-guide.ts` | still true (read whole in round 3): its refusals are evidence (the judge's role, identity, capture) and the testing secrets' safety |
| `link-chat-account` | `guides/link-chat-guide.ts` | still true (read whole in round 3): its refusals say who a chat account is, which is access |

### Repository texts

| Text | Path | Status |
|---|---|---|
| Constitution | `docs/VISION.md` | rewritten (round 1): `kernel-hard-policy-soft` |
| Repo instructions | `CLAUDE.md` | rewritten (round 1) |
| Gates and their origins | `scripts/README.md` | still true: read in round 1's sweep (criterion 6, judged pass at 4efa1e10), unchanged |
| Teaching out of code | `docs/proposals/teaching-out-of-code.md` | deleted (round 2): the master skill and pipeline rules it proposed to render are rendered |
| Policy mechanisms that force | `docs/proposals/teach-not-force-mechanisms.md` | rewritten (round 1); it now points here for the inventory |
| Bundled skills' README | `packages/core/skills/README.md` | rewritten (round 2): the doors marker and the hash over the rendered text |
| Code comments that teach | header comments of `support/act-cards.ts`, `support/room-cards.ts`, `prompt/door-map.ts`, `prompt/facts/affordance-cards.ts`, `lib/door-catalog.ts` | still true (read in round 2) |
| New code comments that teach | `support/tool-description.ts`, `prompt/facts/issue-doors.ts`, `skills/rendered-doors.ts`, `guides/master-guide.ts` | new (round 2) |

## 3. Every forcing mechanism found

Converted in round 1, each with its forcing path removed in the same change:

| Mechanism | Became |
|---|---|
| The memory write's code-block refusal | the `CODE_BLOCK_LONG` warning |
| The debts door's refusal of a red rated high (`cleanup/rules.ts:debtRefusals`) | the `RED_RATED_HIGH` warning (`cleanup/rules.ts:debtWarnings`) |
| The stop gate's dirty-tree refusal | journalled (`packages/runner/crates/runner-core/src/stop_gate.rs:decide`) |

Converted in round 3: the assistant's memory-note gate (`assistant/tools/memory-note-gate.ts:memoryNotePreCall`)
became a finding put before the note tool's result, the note written; `memory-note-gate.test.ts` goes
red when the refusal or the turn loop's stand-in comes back.

Written up in `docs/proposals/teach-not-force-mechanisms.md`, with why each waits (a requirement
leads, or a person set the gate) and what converting it means:

- `knowledge/subject-held.ts:subjectHeldRefusal` (`KNOWLEDGE_SUBJECT_HELD`)
- `memory/write-service.ts:landingOfCuratedWrite`
- `knowledge/provenance.ts` (`KNOWLEDGE_PROVENANCE_MISSING`)
- `issues/create-service.ts:refuseChatDoorFiling` (`CHAT_FILES_FEEDBACK_NOT_ISSUES`)
- `@forge/contracts/gate-profiles.ts:GATE_CATALOG`: the six gates whose standard default is `enforce`
- `questions/owed.ts:owedBlockerOf` (`QUESTION_AGENT_DECIDES`)
- the message contract and text rules: `messaging/cells.ts`, `messaging/doors.ts:DOORS`, `messaging/text-rules.ts`
- `messaging/reply-opening-rule.ts:withoutFalseOpening`
- the claim rules, figures, status, creation, UI, progress and claim: `messaging/*-rule.ts`
- the reply screens: `assistant/screened-reply.ts:screenedTurnReply`, `messaging/reply-marks.ts:cutHeldSentences`, `repairIssueLinks`, `assistant/confab.ts:correctFalseClaims`
- `assistant/chat-room/escalation-synthesis.ts:synthesizeViaBao`, `ESCALATION_FALLBACK_REPLY`, and the held notice
- `comments/screen.ts:screenAgentComment`
- `assistant/agreement/held-language.ts`
- `issues/draft-release-notes.ts:draftMissingReleaseNotes`
- `issues/criteria/close-verdicts.ts:recordCloseVerdicts`
- `intake/service.ts:registerIntakeAssistant`
- the memory model: `memory/extraction.ts`, `memory/consolidation.ts`, `memory/reconcile.ts`
- `steward/door-prepare.ts:PREPARE`
- `cleanup/gate-debt.ts:recordGateDebt`
- `requirements/room-settle.ts:roomSettleWriter`, `suggestions/kept-preview.ts:writeKeptPreview`
- `onboarding/first-requirements.ts:registerFirstRequirementsCase`
- `feedback/loop-check.ts:sweepResolvedFeedback`
- found in round 3: `suggestions/rules.ts:rejectedBeforeRefusal` and `queueFullRefusal`, `mockups/rules.ts:queueRefusal`, `requirements/draft-picture.ts` (`REQUIREMENT_PICTURE_NOT_DRAWN`), `feedback/triage-checklist.ts:reproductionRefusal`, `steward/diagnosis-end.ts:endUnmovedDiagnosis`

Found in round 2 and not forcing: the rules' kernel lines that stay always-on:

- legal edges and their reason;
- the holder alone moving into `in_progress`, `awaiting_release` and `closed`;
- a close only on a recorded merge, each unmet criterion placed.

These are `VISION: kernel-hard-policy-soft`'s kernel. Each refuses by name.

## Honest costs

- This file is a snapshot. Its sizes go stale with the next card or lesson, and the live figure is
  always `GET /api/projects/:id/metrics/piles`. It is kept only until criterion 12 is judged and the
  mechanisms proposal is settled.
- Round 3 read the texts left unread for forcing, not line by line against every card, so a guide
  may still restate a door its card also carries; the next card sweep is where that is found.
- Rendering a card into a prompt makes the card's length the prompt's. A card grown to its limits
  grows every pipeline and drive prompt that carries it, which is why the drive rules grew by 1 800
  characters.
