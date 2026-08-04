CREATE TABLE "download_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issued_to_user_id" uuid,
	"issued_to_device_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_issued_to_user_id_users_id_fk"
	FOREIGN KEY ("issued_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_issued_to_device_id_devices_id_fk"
	FOREIGN KEY ("issued_to_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "download_tickets_attachment_idx" ON "download_tickets" USING btree ("target_type","attachment_id");
--> statement-breakpoint
-- Swept by the same expiry cadence as upload_tickets.
CREATE INDEX "download_tickets_expires_at_idx" ON "download_tickets" USING btree ("expires_at");
