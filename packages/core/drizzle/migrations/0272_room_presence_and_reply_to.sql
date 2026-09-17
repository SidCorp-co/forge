ALTER TABLE "conversation_messages" ADD COLUMN "reply_to_external_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "presence" jsonb;--> statement-breakpoint
CREATE INDEX "conversation_messages_external_idx" ON "conversation_messages" USING btree ("external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
UPDATE "conversation_messages" SET "external_id" = "delivery_proof"->>'messageId' WHERE "role" = 'assistant' AND "external_id" IS NULL AND "delivery_proof"->>'messageId' IS NOT NULL;
