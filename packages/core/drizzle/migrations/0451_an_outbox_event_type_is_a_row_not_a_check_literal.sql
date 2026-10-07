-- An outbox event type is a row of `outbox_event_types`, which `pipeline_outbox.type` references, in place
-- of the CHECK that thirteen migrations (0385 to 0447) rewrote whole, all 49 literals, to admit one type
-- each. A new event is now one row: `INSERT INTO "outbox_event_types" ("type") VALUES ('<type>');` in its
-- own migration. Two checks hold the table to the registry
-- (packages/contracts/src/outbox-events.ts:OUTBOX_EVENT_TYPES): the core unit test replaying every
-- migration (packages/core/src/db/schema-checks.test.ts), and the boot's migrate step, which exits 1
-- naming any registry type the table lacks before the app serves an emit that would fail
-- (packages/core/src/db/migrate.ts:outboxTypesUnseeded).
--
-- The seed is 0447's 49 literals exactly. An outbox row whose type the seed does not hold cannot exist
-- under 0447's CHECK; if one does, the deploy aborts naming each such type and its count rather than
-- deleting the rows or widening the seed.
--
-- ROLLBACK: ALTER TABLE pipeline_outbox DROP CONSTRAINT pipeline_outbox_type_outbox_event_types_type_fk;
--           re-add 0447's CHECK with the types the table then holds; DROP TABLE outbox_event_types.

CREATE TABLE IF NOT EXISTS "outbox_event_types" (
	"type" text PRIMARY KEY NOT NULL
);--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('issue.created'), ('issue.updated'), ('issue.transitioned'), ('issue.dependency.changed'), ('job.transitioned'), ('run.transitioned'), ('comment.created'), ('comment.updated'), ('comment.deleted'), ('comment.mentioned'), ('question.answered'), ('question.asked'), ('question.transitioned'), ('notification.created'), ('notification.read'), ('user.preferencesChanged'), ('skill.syncRequested'), ('runner.provisionRequested'), ('runner.provisionStatus'), ('source.pushed'), ('source.merged'), ('source.reviewed'), ('integration.changed'), ('workflow.designDecided'), ('channel.documentPublished'), ('channel.gateAsked'), ('channel.gateDecided'), ('channel.threadHeld'), ('contract.versionApproved'), ('contract.requested'), ('ecosystem.buildOwed'), ('requirement.agreed'), ('requirement.returned'), ('requirement.delivered'), ('requirement.accepted'), ('feedback.filed'), ('feedback.verifyAsked'), ('feedback.verifySettled'), ('feedback.reporterTold'), ('release.shipped'), ('release.approvalDecided'), ('credential.tokenChanged'), ('runner.changed'), ('job.changed'), ('session.changed'), ('device.pushed'), ('session.pushed'), ('issue.pushed'), ('conversation.pushed') ON CONFLICT DO NOTHING;--> statement-breakpoint
DO $$
DECLARE
  unknown text;
BEGIN
  SELECT string_agg(format('%s (%s rows)', o.type, o.n), ', ' ORDER BY o.type)
    INTO unknown
    FROM (SELECT type, count(*) AS n FROM pipeline_outbox GROUP BY type) o
   WHERE NOT EXISTS (SELECT 1 FROM outbox_event_types t WHERE t.type = o.type);
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'OUTBOX_TYPE_UNSEEDED: pipeline_outbox holds % — a type outbox_event_types does not seed, which 0447''s CHECK should have refused; name each in the seed (it is an event the registry emits) or delete its rows by hand, then deploy again.', unknown;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_outbox_event_types_type_fk" FOREIGN KEY ("type") REFERENCES "public"."outbox_event_types"("type") ON DELETE no action ON UPDATE no action;
