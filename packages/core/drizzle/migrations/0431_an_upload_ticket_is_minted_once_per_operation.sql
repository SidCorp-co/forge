-- An upload ticket carries the operation id its caller minted, and the stored answer of the PUT
-- that consumed it, so a retry after a lost response is answered with the attachment already
-- stored instead of storing the file a second time. Unique per uploader and target: the same
-- operation id on the same room is one upload. NULL is a ticket minted before this column;
-- tickets live five minutes, so none is replayable, and every mint since names its operation.
--
-- ROLLBACK: DROP INDEX upload_tickets_operation_unique;
--           ALTER TABLE upload_tickets DROP COLUMN result, DROP COLUMN operation_id.

ALTER TABLE "upload_tickets" ADD COLUMN "operation_id" text;
ALTER TABLE "upload_tickets" ADD COLUMN "result" jsonb;
CREATE UNIQUE INDEX "upload_tickets_operation_unique" ON "upload_tickets" ("uploader_id", "target_type", "target_id", "operation_id") WHERE "operation_id" IS NOT NULL;
