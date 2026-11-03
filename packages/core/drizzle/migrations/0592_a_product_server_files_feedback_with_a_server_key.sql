-- A product server files feedback into its one project with a server key (ISS-922): minted by a
-- holder of project.admin, kept as the SHA-256 of its secret, naming the product it speaks for and
-- that product's own agent account, which every filing records as its reporter. A new table; no
-- existing row changes.
--
-- ROLLBACK: DROP TABLE IF EXISTS "feedback_server_keys";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_server_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"product" text NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "feedback_server_keys_product_chk" CHECK ("feedback_server_keys"."product" ~ '[^[:space:]]' AND char_length("feedback_server_keys"."product") <= 64),
	CONSTRAINT "feedback_server_keys_token_hash_chk" CHECK ("feedback_server_keys"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "feedback_server_keys" DROP CONSTRAINT IF EXISTS "feedback_server_keys_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_server_keys" ADD CONSTRAINT "feedback_server_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_server_keys" DROP CONSTRAINT IF EXISTS "feedback_server_keys_account_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_server_keys" ADD CONSTRAINT "feedback_server_keys_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_server_keys" DROP CONSTRAINT IF EXISTS "feedback_server_keys_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_server_keys" ADD CONSTRAINT "feedback_server_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_server_keys" DROP CONSTRAINT IF EXISTS "feedback_server_keys_revoked_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_server_keys" ADD CONSTRAINT "feedback_server_keys_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_server_keys_token_hash_uq" ON "feedback_server_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_server_keys_project_idx" ON "feedback_server_keys" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_server_keys_account_idx" ON "feedback_server_keys" USING btree ("account_id");
