-- ISS-1243. A room agent's routing decision is recorded: support_actions takes the kind
-- `routing_decided`, the act the session takes for a message it was handed, naming the project it
-- chose, the signals it used, its confidence, and whether it answers, gathers, asks or stays silent,
-- with why. Nothing else changes; no row is rewritten.
--
-- ROLLBACK (only while no row holds `routing_decided`): restore support_actions_kind_chk as 0639 wrote it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted', 'promise_made', 'promise_told', 'owner_consented', 'owner_withdrew', 'owner_act', 'owner_sign_in', 'owner_signed_in', 'answer_kept', 'silent', 'routing_decided'));
