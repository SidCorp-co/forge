CREATE TABLE "conversation_index_state" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"indexed_through_seq" integer NOT NULL,
	"indexed_through_at" timestamp with time zone,
	"builder_revision" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_passages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"first_seq" integer NOT NULL,
	"first_offset" integer DEFAULT 0 NOT NULL,
	"last_seq" integer NOT NULL,
	"last_offset" integer NOT NULL,
	"message_count" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"is_open" boolean DEFAULT false NOT NULL,
	"text_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', left("conversation_passages"."text", 100000))) STORED,
	"ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words(left("conversation_passages"."text", 100000)))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_passages_seq_order" CHECK ("conversation_passages"."last_seq" >= "conversation_passages"."first_seq"),
	CONSTRAINT "conversation_passages_count_positive" CHECK ("conversation_passages"."message_count" > 0),
	CONSTRAINT "conversation_passages_offsets_sane" CHECK ("conversation_passages"."first_offset" >= 0 AND "conversation_passages"."last_offset" > 0 AND ("conversation_passages"."last_seq" > "conversation_passages"."first_seq" OR "conversation_passages"."last_offset" > "conversation_passages"."first_offset"))
);
--> statement-breakpoint
ALTER TABLE "conversation_index_state" ADD CONSTRAINT "conversation_index_state_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_passages" ADD CONSTRAINT "conversation_passages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_passages_start_unique" ON "conversation_passages" USING btree ("conversation_id","first_seq","first_offset");--> statement-breakpoint
CREATE INDEX "conversation_passages_conversation_idx" ON "conversation_passages" USING btree ("conversation_id","first_seq");--> statement-breakpoint
CREATE INDEX "conversation_passages_open_idx" ON "conversation_passages" USING btree ("conversation_id") WHERE is_open;--> statement-breakpoint
CREATE INDEX "conversation_passages_text_search_idx" ON "conversation_passages" USING gin ("text_search");--> statement-breakpoint
CREATE INDEX "conversation_passages_ident_search_idx" ON "conversation_passages" USING gin ("ident_search");