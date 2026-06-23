-- Operator "turn off" switch for a device (reversible, distinct from `revoked`).
-- When set, the device is IGNORED by dispatch + interactive-chat device-pick
-- across every project it runs for; it keeps its token + runner bindings and
-- still heartbeats, so clearing it (NULL) makes it eligible again instantly.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;
