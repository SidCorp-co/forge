-- The channel of an ecosystem (ISS-21, slice E3 of the ecosystem design): the documents its members
-- exchange, every lifecycle act on them, and the holds people put on a conversation. A document is
-- mutable only while it is a draft or was returned; from submit its number is fixed, from publish
-- the row is write-once and UPDATE and DELETE are refused in the database. A published document
-- ends by one withdraw or supersede event, never by editing it, and a document ends at most once.
-- Events and holds are write-once, a hold is a person's, and channel_counters (created empty by
-- 0323) only counts up, so a number is never issued twice. Every table is new and starts empty;
-- rollback is dropping them and the trigger on channel_counters.
CREATE TABLE "channel_document_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"verb" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_via" text NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text,
	"superseded_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_document_events_verb_chk" CHECK ("channel_document_events"."verb" IN ('draft', 'edit', 'submit', 'approve', 'return', 'publish', 'withdraw', 'supersede')),
	CONSTRAINT "channel_document_events_end_chk" CHECK (("channel_document_events"."verb" NOT IN ('withdraw', 'supersede') OR ("channel_document_events"."reason" IS NOT NULL AND length("channel_document_events"."reason") BETWEEN 1 AND 500)) AND (("channel_document_events"."verb" = 'supersede') = ("channel_document_events"."superseded_by" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "channel_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_project_id" uuid NOT NULL,
	"to_project_ids" uuid[] NOT NULL,
	"number" text,
	"state" text NOT NULL,
	"in_reply_to" text,
	"thread" text,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_via" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "channel_documents_type_chk" CHECK ("channel_documents"."type" IN ('change-notice', 'acknowledgement', 'rfi', 'change-request', 'decision')),
	CONSTRAINT "channel_documents_state_chk" CHECK ("channel_documents"."state" IN ('draft', 'submitted', 'returned', 'published')),
	CONSTRAINT "channel_documents_numbered_chk" CHECK ("channel_documents"."state" = 'draft' OR "channel_documents"."number" IS NOT NULL),
	CONSTRAINT "channel_documents_published_chk" CHECK (("channel_documents"."state" = 'published') = ("channel_documents"."published_at" IS NOT NULL)),
	CONSTRAINT "channel_documents_author_chk" CHECK (("channel_documents"."author_kind" = 'agent' AND "channel_documents"."author_via" = 'master') OR ("channel_documents"."author_kind" = 'person' AND "channel_documents"."author_via" IN ('assistant', 'web', 'cli')))
);
--> statement-breakpoint
CREATE TABLE "channel_thread_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"action" text NOT NULL,
	"by_kind" text NOT NULL,
	"by_id" text NOT NULL,
	"by_via" text NOT NULL,
	"user_id" uuid NOT NULL,
	"side_project_id" uuid NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_thread_holds_action_chk" CHECK ("channel_thread_holds"."action" IN ('hold', 'release')),
	CONSTRAINT "channel_thread_holds_person_chk" CHECK ("channel_thread_holds"."by_kind" = 'person' AND "channel_thread_holds"."by_via" IN ('assistant', 'web', 'cli')),
	CONSTRAINT "channel_thread_holds_reason_chk" CHECK ("channel_thread_holds"."action" <> 'hold' OR ("channel_thread_holds"."reason" IS NOT NULL AND length("channel_thread_holds"."reason") BETWEEN 1 AND 1000))
);
--> statement-breakpoint
ALTER TABLE "channel_document_events" ADD CONSTRAINT "channel_document_events_document_id_channel_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."channel_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_document_events" ADD CONSTRAINT "channel_document_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_documents" ADD CONSTRAINT "channel_documents_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_documents" ADD CONSTRAINT "channel_documents_from_project_id_projects_id_fk" FOREIGN KEY ("from_project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_documents" ADD CONSTRAINT "channel_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_thread_holds" ADD CONSTRAINT "channel_thread_holds_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_thread_holds" ADD CONSTRAINT "channel_thread_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_thread_holds" ADD CONSTRAINT "channel_thread_holds_side_project_id_projects_id_fk" FOREIGN KEY ("side_project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_document_events_document_id_idx" ON "channel_document_events" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_document_events_ends_once_uq" ON "channel_document_events" USING btree ("document_id") WHERE verb IN ('withdraw', 'supersede');--> statement-breakpoint
CREATE UNIQUE INDEX "channel_documents_number_uq" ON "channel_documents" USING btree ("number");--> statement-breakpoint
CREATE INDEX "channel_documents_ecosystem_state_idx" ON "channel_documents" USING btree ("ecosystem_id","state");--> statement-breakpoint
CREATE INDEX "channel_documents_from_project_id_idx" ON "channel_documents" USING btree ("from_project_id");--> statement-breakpoint
CREATE INDEX "channel_documents_to_project_ids_idx" ON "channel_documents" USING gin ("to_project_ids");--> statement-breakpoint
CREATE INDEX "channel_documents_thread_idx" ON "channel_documents" USING btree ("thread");--> statement-breakpoint
CREATE INDEX "channel_thread_holds_thread_idx" ON "channel_thread_holds" USING btree ("thread","at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION channel_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.number IS NOT NULL THEN
      RAISE EXCEPTION 'channel_documents: % holds number %, and a numbered document is never deleted', OLD.id, OLD.number;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'channel_documents: % is published and write-once; it is withdrawn or superseded, never changed', OLD.number;
  END IF;
  IF NEW.id <> OLD.id OR NEW.ecosystem_id <> OLD.ecosystem_id OR NEW.type <> OLD.type
     OR NEW.from_project_id <> OLD.from_project_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'channel_documents: %: the ecosystem, type, sender and creation are fixed at draft', OLD.id;
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'channel_documents: %: number % is fixed once reserved', OLD.id, OLD.number;
  END IF;
  IF NOT ((OLD.state = 'draft' AND NEW.state IN ('draft', 'submitted', 'published'))
       OR (OLD.state = 'submitted' AND NEW.state IN ('published', 'returned'))
       OR (OLD.state = 'returned' AND NEW.state = 'draft')) THEN
    RAISE EXCEPTION 'channel_documents: %: % -> % is not a transition; draft -> draft | submitted | published, submitted -> published | returned, returned -> draft', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_documents_guard_trg BEFORE UPDATE OR DELETE ON "channel_documents" FOR EACH ROW EXECUTE FUNCTION channel_document_guard();--> statement-breakpoint
CREATE TRIGGER channel_document_events_write_once_trg BEFORE UPDATE OR DELETE ON "channel_document_events" FOR EACH ROW EXECUTE FUNCTION ecosystem_write_once();--> statement-breakpoint
CREATE OR REPLACE FUNCTION channel_document_end_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_state text;
BEGIN
  SELECT state INTO current_state FROM channel_documents WHERE id = NEW.document_id;
  IF current_state IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'channel_document_events: % ends only a published document, and % is %', NEW.verb, NEW.document_id, coalesce(current_state, 'absent');
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_document_events_end_trg BEFORE INSERT ON "channel_document_events" FOR EACH ROW WHEN (NEW.verb IN ('withdraw', 'supersede')) EXECUTE FUNCTION channel_document_end_guard();--> statement-breakpoint
CREATE TRIGGER channel_thread_holds_write_once_trg BEFORE UPDATE OR DELETE ON "channel_thread_holds" FOR EACH ROW EXECUTE FUNCTION ecosystem_write_once();--> statement-breakpoint
CREATE OR REPLACE FUNCTION channel_counter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel_counters: the % counter of % is never deleted, or a number would be issued twice', OLD.type, OLD.ecosystem_id;
  END IF;
  IF NEW.ecosystem_id <> OLD.ecosystem_id OR NEW.type <> OLD.type OR NEW.last_number <= OLD.last_number THEN
    RAISE EXCEPTION 'channel_counters: the % counter of % only counts up, from %', OLD.type, OLD.ecosystem_id, OLD.last_number;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_counters_guard_trg BEFORE UPDATE OR DELETE ON "channel_counters" FOR EACH ROW EXECUTE FUNCTION channel_counter_guard();
