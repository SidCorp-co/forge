-- ISS-751 (REQ-75 r7 BC-42): a channel's record names the agent session answering it. Forge's own
-- bot is read off the channel's room and its session; an agent outside Forge (Babo answering a group
-- a binding names in `outsideRids`) declares itself on the channel: its role, the box it runs on and
-- the address it is reached at now, written again each time it restarts. Four columns, all set or
-- all empty (`support_channels_agent_chk`). Additive: no row is rewritten, so nothing is lost.
--
-- ROLLBACK:
--   ALTER TABLE support_channels DROP CONSTRAINT support_channels_agent_chk,
--     DROP COLUMN agent_role, DROP COLUMN agent_box, DROP COLUMN agent_address,
--     DROP COLUMN agent_declared_at, DROP COLUMN agent_declared_by;
ALTER TABLE support_channels
  ADD COLUMN agent_role text,
  ADD COLUMN agent_box text,
  ADD COLUMN agent_address text,
  ADD COLUMN agent_declared_at timestamptz,
  ADD COLUMN agent_declared_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE support_channels ADD CONSTRAINT support_channels_agent_chk CHECK (
  (agent_role IS NULL AND agent_box IS NULL AND agent_address IS NULL AND agent_declared_at IS NULL)
  OR (agent_role IS NOT NULL AND agent_box IS NOT NULL AND agent_address IS NOT NULL
      AND agent_declared_at IS NOT NULL)
);
