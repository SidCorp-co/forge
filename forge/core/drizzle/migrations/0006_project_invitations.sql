CREATE TABLE "project_invitations" (
	"token" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"inviter_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_invitations_project_email_idx" ON "project_invitations" USING btree ("project_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_project_email_pending_uq" ON "project_invitations" USING btree ("project_id","email") WHERE accepted_at IS NULL;