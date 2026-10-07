-- What's new reads Forge's own released changes by time, and remembers per person what they have
-- seen of the product. Two new tables, no existing row touched:
--   user_product_state — one row per person and key; the key namespace is closed to
--     `whats_new_seen_at` and `tour:<kebab-id>`, so a free-text key is refused by the database too.
--   whats_new_digests — one weekly summary per project and ISO week, written by an agent over that
--     week's entries.
--
-- ROLLBACK: DROP TABLE IF EXISTS whats_new_digests; DROP TABLE IF EXISTS user_product_state;

CREATE TABLE IF NOT EXISTS "user_product_state" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_product_state_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "user_product_state_key_chk" CHECK ("user_product_state"."key" = 'whats_new_seen_at' OR "user_product_state"."key" ~ '^tour:[a-z0-9]+(-[a-z0-9]+)*$' AND length("user_product_state"."key") <= 69)
);--> statement-breakpoint
ALTER TABLE "user_product_state" DROP CONSTRAINT IF EXISTS "user_product_state_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_product_state" ADD CONSTRAINT "user_product_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whats_new_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"week" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entry_keys" text[] NOT NULL,
	"written_by" uuid NOT NULL,
	"written_agency" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whats_new_digests_week_chk" CHECK ("whats_new_digests"."week" ~ '^[0-9]{4}-W[0-9]{2}$'),
	CONSTRAINT "whats_new_digests_agency_chk" CHECK ("whats_new_digests"."written_agency" IN ('human', 'agent')),
	CONSTRAINT "whats_new_digests_entry_keys_chk" CHECK (cardinality("whats_new_digests"."entry_keys") > 0)
);--> statement-breakpoint
ALTER TABLE "whats_new_digests" DROP CONSTRAINT IF EXISTS "whats_new_digests_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "whats_new_digests" ADD CONSTRAINT "whats_new_digests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whats_new_digests" DROP CONSTRAINT IF EXISTS "whats_new_digests_written_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "whats_new_digests" ADD CONSTRAINT "whats_new_digests_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whats_new_digests_project_week_uq" ON "whats_new_digests" USING btree ("project_id","week");
