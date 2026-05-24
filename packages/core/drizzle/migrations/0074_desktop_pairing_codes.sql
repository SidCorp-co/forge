-- ADR 0019 supersedes ADR 0017. Replace the PKCE deep-link handoff with a
-- short pairing code the user types into the web UI after signing in.
-- Different table name from the existing `pairing_codes` (project-level
-- device pairing) to avoid collision.

-- Drop the legacy PKCE handoff. In-flight rows are dropped intentionally —
-- 5 min TTL means the impact window is bounded.
DROP INDEX IF EXISTS oauth_handoff_expires_idx;
DROP TABLE IF EXISTS oauth_handoff;

CREATE TABLE desktop_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  device_label text NOT NULL,
  device_platform text NOT NULL,
  device_hostname text,
  created_ip text,
  created_user_agent text,
  approved_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  approved_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX desktop_pairing_codes_expires_idx ON desktop_pairing_codes(expires_at);
CREATE INDEX desktop_pairing_codes_consumed_idx
  ON desktop_pairing_codes(consumed_at)
  WHERE consumed_at IS NOT NULL;
