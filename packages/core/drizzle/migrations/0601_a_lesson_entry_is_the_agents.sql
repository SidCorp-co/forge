-- A lesson's knowledge entry is the agent's (REQ-50 BC-2, decision 4ca95ce9 on REQ-50): the steward
-- decides every lesson, yet `knowledge/lesson-entries.ts:putLessonEntry` wrote each entry
-- `authored_by = 'human'` and its rewrite kept whatever the row held, so every approved lesson read as
-- a person's knowledge. The writer now says `agent` on insert and rewrite; this sets it on every
-- `kind = 'lesson'` entry still reading `human` (a lesson's own `lesson-<n>` and a month's figures,
-- which the steward's pass writes as `agent` already). No other entry is touched, and nothing is
-- deleted.
--
-- ROLLBACK: none. Which rows read `human` before is not kept, and no person ever wrote a lesson entry:
-- the knowledge door refuses kind `lesson` (`lessonOwnedRefusal`).

UPDATE "knowledge_entries" SET "authored_by" = 'agent' WHERE "kind" = 'lesson' AND "authored_by" = 'human';
