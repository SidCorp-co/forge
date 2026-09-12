CREATE TABLE "rocketchat_question_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rocketchat_question_threads" (
	"question_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"rid" text NOT NULL,
	"tmid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rocketchat_question_deliveries" ADD CONSTRAINT "rocketchat_question_deliveries_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD CONSTRAINT "rocketchat_question_threads_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD CONSTRAINT "rocketchat_question_threads_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_deliveries_question_round_idx" ON "rocketchat_question_deliveries" USING btree ("question_id","round");--> statement-breakpoint
CREATE INDEX "rcq_deliveries_status_idx" ON "rocketchat_question_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_threads_room_idx" ON "rocketchat_question_threads" USING btree ("connection_id","rid","tmid");