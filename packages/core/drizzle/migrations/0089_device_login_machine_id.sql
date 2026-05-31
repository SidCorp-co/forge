-- Carry the stable machine id through the browser-approve login flow.
--
-- Adds `device_login_codes.machine_id` so init→approve→poll can hand the
-- runner's /etc/machine-id (hashed) to issueOrRotateDeviceTokenByMachine,
-- giving browser-approve login the same re-pair-keeps-device dedup as the
-- paste-code flow.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0082/0087/0088 headers). Runtime migrator applies
-- this from _journal.json.

ALTER TABLE "device_login_codes" ADD COLUMN IF NOT EXISTS "machine_id" text;
