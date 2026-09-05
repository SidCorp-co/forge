CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"text_content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_revisions_memory_replaced_idx" ON "memory_revisions" USING btree ("memory_id","replaced_at");--> statement-breakpoint
CREATE INDEX "memory_revisions_project_ref_idx" ON "memory_revisions" USING btree ("project_id","source_ref");--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_record_memory_replacement() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO memory_revisions (memory_id, project_id, source, source_ref, text_content, metadata)
  VALUES (OLD.id, OLD.project_id, OLD.source, OLD.source_ref, OLD.text_content, OLD.metadata);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER memories_record_replacement
  AFTER UPDATE ON memories
  FOR EACH ROW
  WHEN (
    OLD.text_content IS DISTINCT FROM NEW.text_content
    AND NEW.source IN ('note', 'knowledge', 'policy')
  )
  EXECUTE FUNCTION forge_record_memory_replacement();
