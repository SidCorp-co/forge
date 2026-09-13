-- ISS-992 — an issue reference names its project.
--
-- Both statements are ADDITIVE: a nullable column on `projects` and a new table. Every existing
-- row comes through untouched and code that has never heard of either keeps working, which is what
-- makes the way back a revert of the application and not of the schema.
--
-- `issue_prefix_aliases` is only ever inserted into. `project_id` goes NULL when its project is
-- deleted and the row STAYS, because freeing a dead project's prefix would let a second project
-- claim it and silently re-point every published `FD-977` at a different issue 977.
CREATE TABLE "issue_prefix_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_prefix_aliases_project_prefix_uq" UNIQUE("project_id","prefix"),
	-- The shape the parser accepts, enforced where a restore and a psql session are held to it too.
	-- Without it a direct write of 'fd' coexists with 'FD' under the case-sensitive unique index and
	-- both projects answer to the same apparent FD-977. 'ISS' is the shared legacy prefix and is
	-- never any one project's.
	CONSTRAINT "issue_prefix_aliases_prefix_shape" CHECK ("prefix" ~ '^[A-Z][A-Z0-9]{1,5}$' AND "prefix" <> 'ISS')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "issue_prefix" text;--> statement-breakpoint
ALTER TABLE "issue_prefix_aliases" ADD CONSTRAINT "issue_prefix_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_prefix_aliases_prefix_uq" ON "issue_prefix_aliases" USING btree ("prefix");--> statement-breakpoint
-- The pointer may only name a prefix this project already holds. MATCH SIMPLE skips the check
-- while `issue_prefix` is NULL, which is what leaves the legacy `ISS` default free.
ALTER TABLE "projects" ADD CONSTRAINT "projects_issue_prefix_fk" FOREIGN KEY ("id","issue_prefix") REFERENCES "public"."issue_prefix_aliases"("project_id","prefix") ON DELETE no action ON UPDATE no action;

--> statement-breakpoint
-- A prefix is a claim on the whole deployment and is never given up. The application only ever
-- inserts here, but an operator, a restore or later code reaches the table directly, and a spent
-- prefix freed by any of them lets a second project claim it and silently re-points every published
-- `FD-977` at a different issue 977. The one mutation the design needs is the tombstone the project
-- FK performs on delete: `project_id` non-null -> NULL. Everything else is refused in Postgres.
CREATE FUNCTION "issue_prefix_aliases_immutable"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'issue_prefix_aliases is insert-only: a prefix is never given up (ISS-992)';
	END IF;
	IF NEW."prefix" IS DISTINCT FROM OLD."prefix" THEN
		RAISE EXCEPTION 'issue_prefix_aliases.prefix is immutable: % cannot become % (ISS-992)', OLD."prefix", NEW."prefix";
	END IF;
	IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND NEW."project_id" IS NOT NULL THEN
		RAISE EXCEPTION 'issue_prefix_aliases.project_id may only go NULL (the tombstone), never to another project (ISS-992)';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_prefix_aliases_immutable_trg"
	BEFORE UPDATE OR DELETE ON "issue_prefix_aliases"
	FOR EACH ROW EXECUTE FUNCTION "issue_prefix_aliases_immutable"();
