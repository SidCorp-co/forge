ALTER TABLE "comments" ADD COLUMN "format" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "description_format" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "description_template" text;