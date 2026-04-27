-- v0.1.6 (ISS-297) — projects settings fields + device pool junction
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "production_branch" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_device_id" uuid REFERENCES "devices"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "projects_default_device_id_idx" ON "projects" USING btree ("default_device_id");--> statement-breakpoint

CREATE TABLE "project_devices" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "project_devices_pk" PRIMARY KEY ("project_id","device_id")
);--> statement-breakpoint
CREATE INDEX "project_devices_device_id_idx" ON "project_devices" USING btree ("device_id");
