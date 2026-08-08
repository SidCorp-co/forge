CREATE TABLE "update_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change" text NOT NULL,
	"story" text NOT NULL,
	"intent_class" text NOT NULL,
	"applies_to" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_packets_story_not_empty" CHECK (length(trim("story")) > 0)
);
--> statement-breakpoint
CREATE INDEX "update_packets_created_at_idx" ON "update_packets" USING btree ("created_at");
