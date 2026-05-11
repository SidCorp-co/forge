-- ISS-93 — track the device principal that uploaded a comment attachment.
-- The MCP `forge_comments` create path runs as a device (workers without an
-- email-verified user session), so we keep `uploader_id` pointed at the
-- device's owner user and record the device row in a companion column.
-- Mirrors the (user notNull, device nullable) audit pattern on `jobs`.
ALTER TABLE "comment_attachments"
  ADD COLUMN "uploader_device_id" uuid;

ALTER TABLE "comment_attachments"
  ADD CONSTRAINT "comment_attachments_uploader_device_id_fk"
  FOREIGN KEY ("uploader_device_id") REFERENCES "devices"("id") ON DELETE SET NULL;

CREATE INDEX "comment_attachments_uploader_device_id_idx"
  ON "comment_attachments" ("uploader_device_id");
