-- Down for 0258_conversation_mode (ISS-1039).
--
-- Reverses the two things 0258 added: the room's answer mode, and the ninth
-- window decision a handed-off turn closes under.
--
-- The re-stamp below is deliberate and is NOT a cleanup: a window closed
-- `handed-off` is a live runner turn whose reply has not arrived, and the
-- narrowed constraint cannot represent it. It becomes `undetermined`, which is
-- the honest reading once the code that would have delivered it is gone — a
-- delivery was started and nobody recorded how it ended. Deleting those rows
-- instead would remove the only record that the question was ever routed.
BEGIN;

UPDATE "conversation_windows"
   SET "decision" = 'undetermined',
       "decision_detail" = coalesce("decision_detail", '{}'::jsonb)
                           || jsonb_build_object('restampedFrom', 'handed-off', 'by', '0258_down')
 WHERE "decision" = 'handed-off';

ALTER TABLE "conversation_windows" DROP CONSTRAINT "conversation_windows_decision_known";
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_decision_known" CHECK ("conversation_windows"."decision" IS NULL OR "conversation_windows"."decision" IN ('answered','nothing-to-say','guard-backoff','guard-agent-loop','guard-dormant','authority-refused','unreachable','undetermined'));

ALTER TABLE "conversations" DROP CONSTRAINT "conversations_mode_known";
ALTER TABLE "conversations" DROP COLUMN "mode";

COMMIT;
