-- ISS-60 — issue-level attachments. Mirrors comment_attachments shape so the
-- existing storage flow (StorageAdapter put/get/delete) extends naturally.
-- on_delete cascade from issues; restrict from users so we keep history if a
-- user is purged.
CREATE TABLE "issue_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "uploader_id" uuid NOT NULL,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_attachments_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE,
  CONSTRAINT "issue_attachments_uploader_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE INDEX "issue_attachments_issue_id_idx" ON "issue_attachments" ("issue_id");
