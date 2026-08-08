CREATE TABLE "skill_activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"packet_id" text,
	"project_id" uuid,
	"skill_id" uuid,
	"device_id" uuid,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"trigger" text NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"delta_summary" text,
	"reason" text,
	"outcome" text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_activity_events" ADD CONSTRAINT "skill_activity_events_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_activity_events" ADD CONSTRAINT "skill_activity_events_skill_id_skills_id_fk"
	FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_activity_events" ADD CONSTRAINT "skill_activity_events_device_id_devices_id_fk"
	FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "skill_activity_events_packet_idx" ON "skill_activity_events" USING btree ("packet_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "skill_activity_events_skill_idx" ON "skill_activity_events" USING btree ("project_id","skill_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "skill_activity_events_device_idx" ON "skill_activity_events" USING btree ("device_id","occurred_at");
