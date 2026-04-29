-- Desktop OAuth PKCE handoff (ADR 0017).
--
-- The Tauri desktop client uses RFC 8252 (OAuth 2.0 for Native Apps) +
-- RFC 7636 (PKCE) to claim a Forge JWT after the user completes the
-- normal web OAuth flow. This table is the cross-process handoff store:
--
--   1. /api/auth/desktop/start     → INSERT row with code_challenge
--   2. (existing /oauth/<p>/start … /callback runs, web cookie set)
--   3. /api/auth/desktop/issue-code → UPDATE: set code_hash + user_id
--   4. /api/auth/desktop/exchange   → UPDATE: set consumed_at, return JWT
--
-- The token never lives in this table — only the one-time `code` (hashed)
-- the desktop trades for the token, plus the PKCE challenge that proves
-- the desktop calling /exchange is the same one that called /start.
--
-- Reversible: DROP TABLE; no FK from anywhere into this table.

CREATE TABLE "oauth_handoff" (
  "id"             text PRIMARY KEY,                      -- url-safe random, 32 bytes
  "provider"       text NOT NULL,                         -- 'github' | 'google' | 'oidc'
  "code_challenge" text NOT NULL,                         -- b64url(SHA256(code_verifier))
  "code_hash"      text,                                  -- SHA256(handoff code), set at issue-code
  "user_id"        uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "consumed_at"    timestamptz,                           -- single-use marker
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "expires_at"     timestamptz NOT NULL                   -- now() + 5 min at insert
);--> statement-breakpoint

-- expires_at index supports the periodic cleanup query
-- (DELETE … WHERE expires_at < now() - interval '1 hour').
CREATE INDEX "oauth_handoff_expires_idx" ON "oauth_handoff" USING btree ("expires_at");
