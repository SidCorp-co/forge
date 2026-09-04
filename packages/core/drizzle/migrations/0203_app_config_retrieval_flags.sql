ALTER TABLE "app_config" ADD COLUMN "retrieval_rerank" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "memory_model" text DEFAULT 'flat' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "retrieval_expand_relations" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_config" ADD COLUMN "memory_reindex" jsonb DEFAULT '{}'::jsonb NOT NULL;