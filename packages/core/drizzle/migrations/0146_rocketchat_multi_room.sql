-- Multi-room Rocket.Chat bindings: binding-tier config moves from a single
-- `rid` to a `rids` array (mirrors coolify's targets[] binding-tier pattern).
-- One-shot rewrite of existing rows; code reads only `rids` after this.
UPDATE integration_bindings
SET config = jsonb_set(config - 'rid', '{rids}', jsonb_build_array(config->'rid'))
WHERE provider = 'rocketchat'
  AND config ? 'rid'
  AND NOT (config ? 'rids');
