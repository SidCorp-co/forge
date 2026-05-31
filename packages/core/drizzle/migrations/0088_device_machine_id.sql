-- Stable per-machine identity for device pairing (machine-id dedup).
--
-- Adds `devices.machine_id` (sha256 hex of the host's /etc/machine-id, sent by
-- the runner at pairing) plus a lookup index on (owner_id, machine_id). When
-- present, re-pairing from the same machine rotates the existing device row in
-- place instead of inserting a duplicate "ghost" device that orphans its
-- runner bindings. NULL for legacy clients → pairing keeps always-insert.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0082/0083/0084/0087 headers). The runtime migrator
-- applies this row from _journal.json.

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "machine_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_owner_machine_idx" ON "devices" ("owner_id","machine_id");
