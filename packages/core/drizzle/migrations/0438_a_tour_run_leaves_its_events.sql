-- Product tours record what happened on each run, per person: started, completed, dismissed at a
-- step, or a step skipped because its anchor was missing from the page. One new insert-only table;
-- no existing row is touched.
--
-- ROLLBACK: DROP TABLE IF EXISTS product_tour_events;

CREATE TABLE IF NOT EXISTS "product_tour_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tour_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_tour_events_kind_chk" CHECK ("product_tour_events"."kind" IN ('started', 'completed', 'dismissed', 'step_skipped')),
	CONSTRAINT "product_tour_events_step_chk" CHECK (("product_tour_events"."kind" IN ('dismissed', 'step_skipped')) = ("product_tour_events"."step" IS NOT NULL) AND ("product_tour_events"."step" IS NULL OR "product_tour_events"."step" BETWEEN 1 AND 4))
);--> statement-breakpoint
ALTER TABLE "product_tour_events" DROP CONSTRAINT IF EXISTS "product_tour_events_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "product_tour_events" ADD CONSTRAINT "product_tour_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_tour_events_tour_idx" ON "product_tour_events" USING btree ("tour_id","revision","created_at");
