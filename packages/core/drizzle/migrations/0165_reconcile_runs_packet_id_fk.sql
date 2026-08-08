-- ISS-801 fix: reconcile_runs.packet_id was text with no FK.
-- update_packets.id is uuid; the trigger MCP tool validates packetId as uuid.
-- This migration aligns the column type and adds referential integrity.

ALTER TABLE "reconcile_runs"
  ALTER COLUMN "packet_id" TYPE uuid USING packet_id::uuid;
--> statement-breakpoint
ALTER TABLE "reconcile_runs"
  ADD CONSTRAINT "reconcile_runs_packet_id_update_packets_id_fk"
  FOREIGN KEY ("packet_id") REFERENCES "public"."update_packets"("id")
  ON DELETE set null ON UPDATE no action;
