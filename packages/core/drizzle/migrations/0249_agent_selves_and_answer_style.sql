CREATE TABLE "agent_selves" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"soul" text,
	"instructions" text,
	"emoji" text,
	"greeting" text,
	"presence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preference_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous_value" text,
	"new_value" text,
	"changed_by" text NOT NULL,
	"changed_by_user_id" uuid,
	"conversation_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "answer_style" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "assistant_instructions" text;--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD COLUMN "origin" text DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_selves" ADD CONSTRAINT "agent_selves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_selves" ADD CONSTRAINT "agent_selves_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_changes" ADD CONSTRAINT "preference_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_changes" ADD CONSTRAINT "preference_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_selves_updated_idx" ON "agent_selves" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "preference_changes_user_changed_idx" ON "preference_changes" USING btree ("user_id","changed_at");--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_origin_known" CHECK ("conversation_windows"."origin" IN ('inbound','heartbeat'));