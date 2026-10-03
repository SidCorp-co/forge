CREATE TABLE "requirement_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"returned_by" uuid NOT NULL,
	"returned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "requirement_returns_reason_chk" CHECK ("requirement_returns"."reason" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "requirement_returns" ADD CONSTRAINT "requirement_returns_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_returns" ADD CONSTRAINT "requirement_returns_revision_fk" FOREIGN KEY ("requirement_id","revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_returns_requirement_idx" ON "requirement_returns" USING btree ("requirement_id","revision");--> statement-breakpoint
CREATE FUNCTION "requirement_return_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'REQUIREMENT_RETURN_IMMUTABLE: a return of requirement % revision % is insert-only; returning again writes a new row', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "requirement_returns_guard" BEFORE UPDATE OR DELETE ON "requirement_returns" FOR EACH ROW EXECUTE FUNCTION "requirement_return_guard"();
