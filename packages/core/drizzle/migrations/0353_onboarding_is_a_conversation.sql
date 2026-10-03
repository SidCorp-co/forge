CREATE TABLE "onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"rounds_sent" integer DEFAULT 0 NOT NULL,
	"designs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_job_id" uuid,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reanalyzed_by" uuid,
	"reanalyzed_at" timestamp with time zone,
	"done_by" uuid,
	"done_agency" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboardings_status_chk" CHECK ("onboardings"."status" IN ('in_progress', 'waiting_on_you', 'done')),
	CONSTRAINT "onboardings_rounds_chk" CHECK ("onboardings"."rounds_sent" BETWEEN 0 AND 3),
	CONSTRAINT "onboardings_done_chk" CHECK (("onboardings"."status" = 'done') = ("onboardings"."done_at" IS NOT NULL AND "onboardings"."done_by" IS NOT NULL)),
	CONSTRAINT "onboardings_done_agency_chk" CHECK ("onboardings"."done_agency" IS NULL OR "onboardings"."done_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "questionnaire_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"onboarding_id" uuid,
	"requirement_id" uuid,
	"title" text NOT NULL,
	"intro" text,
	"round" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"message_id" uuid,
	"answers_message_id" uuid,
	"posted_by" uuid NOT NULL,
	"posted_agency" text NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"skipped_by" uuid,
	"skipped_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_reason" text,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaire_batches_arc_chk" CHECK (num_nonnulls("questionnaire_batches"."onboarding_id", "questionnaire_batches"."requirement_id") = 1),
	CONSTRAINT "questionnaire_batches_status_chk" CHECK ("questionnaire_batches"."status" IN ('open', 'submitted', 'skipped', 'superseded')),
	CONSTRAINT "questionnaire_batches_round_chk" CHECK ("questionnaire_batches"."round" BETWEEN 1 AND 3),
	CONSTRAINT "questionnaire_batches_posted_agency_chk" CHECK ("questionnaire_batches"."posted_agency" IN ('human', 'agent')),
	CONSTRAINT "questionnaire_batches_submitted_chk" CHECK (("questionnaire_batches"."status" = 'submitted') = ("questionnaire_batches"."submitted_at" IS NOT NULL AND "questionnaire_batches"."submitted_by" IS NOT NULL)),
	CONSTRAINT "questionnaire_batches_superseded_chk" CHECK (("questionnaire_batches"."status" = 'superseded') = ("questionnaire_batches"."superseded_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "item" jsonb;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_last_job_id_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_reanalyzed_by_users_id_fk" FOREIGN KEY ("reanalyzed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_onboarding_id_onboardings_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."onboardings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_answers_message_id_conversation_messages_id_fk" FOREIGN KEY ("answers_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_skipped_by_users_id_fk" FOREIGN KEY ("skipped_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_superseded_by_questionnaire_batches_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."questionnaire_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboardings_project_uq" ON "onboardings" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboardings_conversation_uq" ON "onboardings" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_batches_open_conversation_uq" ON "questionnaire_batches" USING btree ("conversation_id") WHERE status IN ('open', 'skipped');--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_batches_open_requirement_uq" ON "questionnaire_batches" USING btree ("requirement_id") WHERE status IN ('open', 'skipped') AND requirement_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "questionnaire_batches_project_idx" ON "questionnaire_batches" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "questionnaire_batches_onboarding_idx" ON "questionnaire_batches" USING btree ("onboarding_id");--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_batch_id_questionnaire_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."questionnaire_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_questions_batch_idx" ON "agent_questions" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_batch_item_chk" CHECK (("agent_questions"."batch_id" IS NULL) = ("agent_questions"."item" IS NULL));