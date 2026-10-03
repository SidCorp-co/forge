CREATE TABLE "item_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requirement_id" uuid,
	"item_type" text GENERATED ALWAYS AS (CASE WHEN "item_embeddings"."requirement_id" IS NOT NULL THEN 'requirement' END) STORED,
	"item_id" uuid GENERATED ALWAYS AS (coalesce("item_embeddings"."requirement_id")) STORED,
	"version" integer NOT NULL,
	"model" text,
	"embedding" vector(1536),
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_embeddings_arc_chk" CHECK (num_nonnulls("item_embeddings"."requirement_id") = 1),
	CONSTRAINT "item_embeddings_status_chk" CHECK ("item_embeddings"."status" IN ('embedded', 'provider_not_configured', 'failed')),
	CONSTRAINT "item_embeddings_embedded_chk" CHECK (("item_embeddings"."status" = 'embedded') = ("item_embeddings"."embedding" IS NOT NULL AND "item_embeddings"."model" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requirement_id" uuid,
	"issue_id" uuid,
	"base_revision" integer,
	"payload" jsonb,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"producer_kind" text NOT NULL,
	"producer_id" uuid,
	"conversation_message_id" uuid,
	"model" text,
	"decided_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"payload_purged_at" timestamp with time zone,
	CONSTRAINT "suggestions_arc_chk" CHECK (num_nonnulls("suggestions"."requirement_id", "suggestions"."issue_id") = 1),
	CONSTRAINT "suggestions_kind_chk" CHECK ("suggestions"."kind" IN ('requirement_draft', 'revision_diff', 'readiness', 'breakdown', 'triage', 'duplicate')),
	CONSTRAINT "suggestions_status_chk" CHECK ("suggestions"."status" IN ('proposed', 'accepted', 'rejected', 'stale', 'withdrawn')),
	CONSTRAINT "suggestions_producer_chk" CHECK ("suggestions"."producer_kind" IN ('ba_assistant', 'agent', 'person')),
	CONSTRAINT "suggestions_decided_chk" CHECK (("suggestions"."status" = 'proposed') = ("suggestions"."decided_at" IS NULL)),
	CONSTRAINT "suggestions_rejected_chk" CHECK ("suggestions"."status" <> 'rejected' OR ("suggestions"."reason" ~ '[^[:space:]]' AND "suggestions"."decided_by" IS NOT NULL)),
	CONSTRAINT "suggestions_payload_chk" CHECK ("suggestions"."payload" IS NOT NULL OR ("suggestions"."payload_purged_at" IS NOT NULL AND "suggestions"."status" IN ('rejected', 'stale', 'withdrawn')))
);
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN "from_suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_producer_id_users_id_fk" FOREIGN KEY ("producer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_conversation_message_id_conversation_messages_id_fk" FOREIGN KEY ("conversation_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_embeddings_item_uq" ON "item_embeddings" USING btree ("item_type","item_id");--> statement-breakpoint
CREATE INDEX "item_embeddings_project_idx" ON "item_embeddings" USING btree ("project_id","item_type");--> statement-breakpoint
CREATE INDEX "item_embeddings_embedding_hnsw_idx" ON "item_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_open_twin_uq" ON "suggestions" USING btree ("kind",coalesce("requirement_id", "issue_id"),"fingerprint") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "suggestions_requirement_idx" ON "suggestions" USING btree ("requirement_id","status") WHERE requirement_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suggestions_issue_idx" ON "suggestions" USING btree ("issue_id","status") WHERE issue_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "suggestions_status_created_idx" ON "suggestions" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_from_suggestion_id_suggestions_id_fk" FOREIGN KEY ("from_suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_questions_requirement_open_uq" ON "agent_questions" USING btree ("requirement_id") WHERE "agent_questions"."status" = 'open' and "agent_questions"."requirement_id" is not null;