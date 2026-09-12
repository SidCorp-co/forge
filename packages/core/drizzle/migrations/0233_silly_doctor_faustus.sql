CREATE TABLE "rocketchat_thread_openings" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"rid" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rocketchat_thread_openings" ADD CONSTRAINT "rocketchat_thread_openings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocketchat_thread_openings" ADD CONSTRAINT "rocketchat_thread_openings_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;