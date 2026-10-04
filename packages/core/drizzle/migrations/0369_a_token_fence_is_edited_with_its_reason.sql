CREATE TABLE "pat_fence_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"changed_by" uuid NOT NULL,
	"previous_project_ids" uuid[],
	"previous_bound_project_id" uuid,
	"project_ids" uuid[],
	"bound_project_id" uuid,
	"reason" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pat_fence_changes_reason_chk" CHECK (char_length(btrim("pat_fence_changes"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "pat_fence_changes_one_fence_chk" CHECK (("pat_fence_changes"."bound_project_id" IS NULL) <> ("pat_fence_changes"."project_ids" IS NULL OR cardinality("pat_fence_changes"."project_ids") = 0))
);
--> statement-breakpoint
ALTER TABLE "pat_fence_changes" ADD CONSTRAINT "pat_fence_changes_token_id_personal_access_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pat_fence_changes" ADD CONSTRAINT "pat_fence_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_fence_changes_token_changed_idx" ON "pat_fence_changes" USING btree ("token_id","changed_at");--> statement-breakpoint
CREATE FUNCTION "pat_fence_change_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "personal_access_tokens" WHERE "id" = OLD."token_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'PAT_FENCE_CHANGE_IMMUTABLE: fence change % of token % is insert-only; a new edit writes a new row, and a row goes only with its token', OLD."id", OLD."token_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "pat_fence_changes_guard" BEFORE UPDATE OR DELETE ON "pat_fence_changes" FOR EACH ROW EXECUTE FUNCTION "pat_fence_change_guard"();
