-- An answer to an item of feedback reaches its reporter's own session once (REQ-47 BC-11): a row per
-- answer (a `triaged` decision on the `answer` route) and reporter, written by the claim that hands it
-- to the session, so a told answer is never told again and a later answer on the item is a new row.
-- Every answer already given is recorded `predates`, for the item's reporter and each repeat's: it
-- was given before answers reached sessions, so no session is handed a backlog on its first prompt.
-- No existing row is rewritten.
--
-- ROLLBACK: DROP TABLE IF EXISTS "feedback_answer_deliveries";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_answer_deliveries" (
	"decision_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"via" text NOT NULL,
	CONSTRAINT "feedback_answer_deliveries_decision_id_user_id_pk" PRIMARY KEY("decision_id","user_id"),
	CONSTRAINT "feedback_answer_deliveries_via_chk" CHECK ("feedback_answer_deliveries"."via" IN ('session', 'predates'))
);--> statement-breakpoint
ALTER TABLE "feedback_answer_deliveries" DROP CONSTRAINT IF EXISTS "feedback_answer_deliveries_decision_id_feedback_decisions_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_answer_deliveries" ADD CONSTRAINT "feedback_answer_deliveries_decision_id_feedback_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."feedback_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answer_deliveries" DROP CONSTRAINT IF EXISTS "feedback_answer_deliveries_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_answer_deliveries" ADD CONSTRAINT "feedback_answer_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_answer_deliveries_user_idx" ON "feedback_answer_deliveries" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "feedback_answer_deliveries" ("decision_id", "user_id", "delivered_at", "via")
SELECT d."id", r."user_id", d."decided_at", 'predates'
FROM "feedback_decisions" d
JOIN "feedback" f ON f."id" = d."feedback_id"
CROSS JOIN LATERAL (
	SELECT f."reported_by" AS "user_id"
	UNION
	SELECT o."reported_by" FROM "feedback_occurrences" o WHERE o."feedback_id" = f."id"
) r
WHERE d."decision" = 'triaged' AND d."route" = 'answer'
ON CONFLICT DO NOTHING;
