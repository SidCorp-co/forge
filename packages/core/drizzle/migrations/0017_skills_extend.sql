ALTER TABLE "skills" ADD COLUMN "skill_md" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "changelog" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "local_guide" text;