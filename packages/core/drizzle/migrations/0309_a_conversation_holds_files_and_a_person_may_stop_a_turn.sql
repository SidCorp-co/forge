CREATE TABLE "conversation_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_attachments" ADD CONSTRAINT "conversation_attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_attachments_conversation_idx" ON "conversation_attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_attachments_uploader_idx" ON "conversation_attachments" USING btree ("uploader_id");--> statement-breakpoint
ALTER TABLE "conversation_windows" DROP CONSTRAINT "conversation_windows_decision_known";--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_decision_known" CHECK ("conversation_windows"."decision" IS NULL OR "conversation_windows"."decision" IN ('answered','nothing-to-say','guard-backoff','guard-agent-loop','guard-dormant','authority-refused','unreachable','undetermined','handed-off','stopped'));
