-- ISS-1336 — a backlog ordering and a duplicate sweep are held between calls instead of recomputed.
--
-- Four tables. `issue_rank_scores` holds one row per takeable issue (every term of its score but
-- age); `issue_alike_seeds` / `issue_alike_hits` hold the nearest issues per unsettled issue;
-- `backlog_index_dirty` is the queue of changes neither has caught up with. Triggers, not
-- application code, write the queue, so a writer that emits no event still marks it. A mark for a
-- project that is being deleted is dropped: the cascade deletes its issues after the project row.
--
-- Additive: no existing column or row changes, old code ignores all of it. The backfill at the end
-- marks every project whole, so the first maintenance pass scores everything that exists.
-- Rollback: revert the code and keep this migration, or drop the triggers, the functions named
-- backlog_index_* and the four tables (docs/modules/issues/backlog-index.md carries the script).
CREATE TABLE "backlog_index_dirty" (
	"index_kind" text NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"first_marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_index_dirty_index_kind_project_id_subject_id_pk" PRIMARY KEY("index_kind","project_id","subject_id"),
	CONSTRAINT "backlog_index_dirty_kind_chk" CHECK ("backlog_index_dirty"."index_kind" IN ('rank', 'alike-seed', 'alike-target'))
);
--> statement-breakpoint
CREATE TABLE "issue_alike_hits" (
	"seed_issue_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"memory_id" uuid NOT NULL,
	"hit_issue_id" uuid,
	"score" real NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	CONSTRAINT "issue_alike_hits_seed_issue_id_position_pk" PRIMARY KEY("seed_issue_id","position")
);
--> statement-breakpoint
CREATE TABLE "issue_alike_seeds" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"title_embedding" vector(1536) NOT NULL,
	"measured_with" text NOT NULL,
	"floor_score" real,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_rank_scores" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"static_score" double precision NOT NULL,
	"parts" jsonb NOT NULL,
	"chain_count" integer NOT NULL,
	"weights_hash" text NOT NULL,
	"fresh_until" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backlog_index_dirty" ADD CONSTRAINT "backlog_index_dirty_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_alike_hits" ADD CONSTRAINT "issue_alike_hits_seed_issue_id_issue_alike_seeds_issue_id_fk" FOREIGN KEY ("seed_issue_id") REFERENCES "public"."issue_alike_seeds"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_alike_seeds" ADD CONSTRAINT "issue_alike_seeds_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_alike_seeds" ADD CONSTRAINT "issue_alike_seeds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_rank_scores" ADD CONSTRAINT "issue_rank_scores_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_rank_scores" ADD CONSTRAINT "issue_rank_scores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backlog_index_dirty_project_kind_idx" ON "backlog_index_dirty" USING btree ("project_id","index_kind","first_marked_at");--> statement-breakpoint
CREATE INDEX "issue_alike_hits_hit_issue_idx" ON "issue_alike_hits" USING btree ("hit_issue_id");--> statement-breakpoint
CREATE INDEX "issue_alike_seeds_project_idx" ON "issue_alike_seeds" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "issue_rank_scores_project_idx" ON "issue_rank_scores" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "issue_rank_scores_lapse_idx" ON "issue_rank_scores" USING btree ("project_id","fresh_until") WHERE fresh_until IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "backlog_index_mark"(p_kind text, p_project uuid, p_subject uuid, p_reason text)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO backlog_index_dirty (index_kind, project_id, subject_id, reason)
  SELECT p_kind, p_project, p_subject, p_reason
   WHERE EXISTS (SELECT 1 FROM projects WHERE id = p_project)
  ON CONFLICT (index_kind, project_id, subject_id)
  DO UPDATE SET generation = backlog_index_dirty.generation + 1, reason = EXCLUDED.reason
$$;--> statement-breakpoint
CREATE FUNCTION "backlog_index_issue_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM backlog_index_mark('rank', OLD.project_id, OLD.id, 'issue deleted');
    PERFORM backlog_index_mark('alike-target', OLD.project_id, OLD.id, 'issue deleted');
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM backlog_index_mark('rank', NEW.project_id, NEW.id, 'issue created');
    PERFORM backlog_index_mark('alike-seed', NEW.project_id, NEW.id, 'issue created');
    RETURN NULL;
  END IF;
  IF (OLD.status, OLD.priority, OLD.category, OLD.complexity, OLD.reopen_count, OLD.created_at, OLD.archived_at)
     IS DISTINCT FROM
     (NEW.status, NEW.priority, NEW.category, NEW.complexity, NEW.reopen_count, NEW.created_at, NEW.archived_at) THEN
    PERFORM backlog_index_mark('rank', NEW.project_id, NEW.id, 'issue changed');
  END IF;
  IF (OLD.title, OLD.status, OLD.archived_at) IS DISTINCT FROM (NEW.title, NEW.status, NEW.archived_at) THEN
    PERFORM backlog_index_mark('alike-seed', NEW.project_id, NEW.id, 'issue changed');
  END IF;
  IF OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN
    PERFORM backlog_index_mark('alike-target', NEW.project_id, NEW.id, 'issue archived or restored');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_issues_insert_delete"
AFTER INSERT OR DELETE ON "issues"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_issue_changed"();--> statement-breakpoint
CREATE TRIGGER "backlog_index_issues_update"
AFTER UPDATE OF "status", "priority", "category", "complexity", "reopen_count", "created_at", "archived_at", "title" ON "issues"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_issue_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_edge_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.kind = 'blocks' THEN
    PERFORM backlog_index_mark('rank', NEW.project_id, NEW.from_issue_id, 'blocks edge changed');
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.kind = 'blocks' THEN
    PERFORM backlog_index_mark('rank', OLD.project_id, OLD.from_issue_id, 'blocks edge changed');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_edges_changed"
AFTER INSERT OR UPDATE OR DELETE ON "issue_dependencies"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_edge_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_issue_label_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue uuid;
  v_project uuid;
BEGIN
  v_issue := CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
  SELECT project_id INTO v_project FROM issues WHERE id = v_issue;
  IF FOUND THEN
    PERFORM backlog_index_mark('rank', v_project, v_issue, 'issue label changed');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_issue_labels_changed"
AFTER INSERT OR UPDATE OR DELETE ON "issue_labels"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_issue_label_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_module_label_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'module' THEN
      PERFORM backlog_index_mark('rank', OLD.project_id, '00000000-0000-0000-0000-000000000000', 'module label deleted');
    END IF;
  ELSIF OLD.kind = 'module' OR NEW.kind = 'module' THEN
    PERFORM backlog_index_mark('rank', NEW.project_id, '00000000-0000-0000-0000-000000000000', 'module label changed');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_labels_changed"
AFTER UPDATE OF "name", "kind", "parent_id" OR DELETE ON "labels"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_module_label_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_rank_weights_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM backlog_index_mark('rank', NEW.id, '00000000-0000-0000-0000-000000000000', 'rank weights changed');
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_projects_rank_weights"
AFTER UPDATE OF "agent_config" ON "projects"
FOR EACH ROW
WHEN ((OLD.agent_config #> '{pipelineConfig,rank}') IS DISTINCT FROM (NEW.agent_config #> '{pipelineConfig,rank}'))
EXECUTE FUNCTION "backlog_index_rank_weights_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_memory_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF r.source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM backlog_index_mark('alike-target', r.project_id, r.source_ref::uuid, 'issue memory changed');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_memories_insert"
AFTER INSERT ON "memories"
FOR EACH ROW WHEN (NEW.source = 'issue')
EXECUTE FUNCTION "backlog_index_memory_changed"();--> statement-breakpoint
CREATE TRIGGER "backlog_index_memories_update"
AFTER UPDATE ON "memories"
FOR EACH ROW
WHEN (NEW.source = 'issue' AND (
  OLD.embedding IS DISTINCT FROM NEW.embedding
  OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
  OR OLD.source_ref IS DISTINCT FROM NEW.source_ref
  OR (OLD.metadata -> 'staleSince') IS DISTINCT FROM (NEW.metadata -> 'staleSince')
  OR (OLD.metadata -> 'supersededBy') IS DISTINCT FROM (NEW.metadata -> 'supersededBy')
))
EXECUTE FUNCTION "backlog_index_memory_changed"();--> statement-breakpoint
CREATE TRIGGER "backlog_index_memories_delete"
AFTER DELETE ON "memories"
FOR EACH ROW WHEN (OLD.source = 'issue')
EXECUTE FUNCTION "backlog_index_memory_changed"();--> statement-breakpoint
CREATE FUNCTION "backlog_index_memory_chunk_changed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_memory uuid;
  v_project uuid;
  v_ref text;
BEGIN
  v_memory := CASE WHEN TG_OP = 'DELETE' THEN OLD.memory_id ELSE NEW.memory_id END;
  SELECT project_id, source_ref INTO v_project, v_ref FROM memories WHERE id = v_memory AND source = 'issue';
  IF FOUND AND v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM backlog_index_mark('alike-target', v_project, v_ref::uuid, 'issue memory chunk changed');
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "backlog_index_memory_chunks_changed"
AFTER INSERT OR DELETE OR UPDATE OF "embedding" ON "memory_chunks"
FOR EACH ROW EXECUTE FUNCTION "backlog_index_memory_chunk_changed"();--> statement-breakpoint
INSERT INTO "backlog_index_dirty" ("index_kind", "project_id", "subject_id", "reason")
SELECT k.kind, p.id, '00000000-0000-0000-0000-000000000000', 'migration 0327 backfill'
FROM "projects" p CROSS JOIN (VALUES ('rank'), ('alike-seed')) AS k(kind)
ON CONFLICT DO NOTHING;
