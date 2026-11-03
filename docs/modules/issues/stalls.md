# Delivery stalls: what one is, where it starts and ends

REQ-67 measures its goal by "delivery stalls per release caused by an unclear item, trending to
zero". A stall is a row of `stalls` (`packages/core/src/db/schema-stalls.ts`), written by one writer,
`packages/core/src/issues/stalls.ts:startStall`, in the transaction of the act that starts it, and
ended in the act that clears it. A stall nobody cleared keeps `ended_at` empty and is read as open:
it is never dropped.

| cause | starts | ends |
|---|---|---|
| `unclear_item` | a question the ask door names as about a requirement or feedback item (`about`), or a reporter's clarification on a feedback item: `packages/core/src/questions/stall-start.ts:startQuestionStall`, called by `insertQuestion` | the question answered (`answered`), or voided, expired or deleted (`withdrawn`), in the statement that ends it: `stalls_question_end_trg` and `stalls_question_gone_trg` on `agent_questions` |
| `defect` | a failed verdict's reopen: `packages/core/src/issues/fail-reopen.ts:reopenOnFail` | the next merge mark (`merge-record.ts:recordIssueMerge`, `recordDesignLanding`), a move to `awaiting_release` or `closed` (`merged`), or a drop (`dropped`) |
| `waiting_on_person` | a `needs_info` park: `packages/core/src/issues/stalls.ts:stallsOfMove` | leaving `needs_info` (`resumed`), or a drop (`dropped`) |

What is not a stall, by decision:

- A park on another issue's merge mark (`awaitsMerge`) waits on ordering, which is a blocks edge's
  business, not a person's.
- A park whose question names a requirement or feedback item is an unclear item, recorded once by the
  question it mints, not a second time as a wait.
- A steward's decision about an item is triage: it names a feedback item in-process (`{ feedbackId }`)
  or a requirement by `requirementId`, and neither starts a stall. A requirement's own open questions,
  asked while it is written, are product work before delivery, not a delivery stall.

Each row names its project, cause, requirement or feedback item where the cause names one, issue
where it stalled one, the question it raised (its id and its words, kept when the question row goes),
and when it started and ended. A cause the writer cannot place is refused by name
(`STALL_CAUSE_UNKNOWN`, `STALL_ITEM_MISSING`, `STALL_ISSUE_MISSING`), never guessed.

## Which release a stall counts on

Read through the release's roster at read time, never stored:
`packages/core/src/issues/stalls-read.ts:stallsOfRoster`. A stall counts on a release when the issue
it stalled is on the roster, or, asked on no issue, when a roster issue delivers its requirement or
carries its feedback item; and it started before the release went out (any start, while it has not).
The roster is the release's own record of what it shipped, so the count never names an issue the
release does not, and no cut path has to remember to write it. An issue shipped by two releases
shows a stall that started before the first on both pages; one that started between them counts on
the second only.

The release page (`packages/core/src/release-page/read.ts:readReleasePage`) carries the result as
`stalls`; a frozen share carries none (`null`), since a stall is the team's record.
