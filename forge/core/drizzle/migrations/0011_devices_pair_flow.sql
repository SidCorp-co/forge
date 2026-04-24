ALTER TABLE "pairing_codes" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pairing_codes_project_id_idx" ON "pairing_codes" USING btree ("project_id");