-- An MCP client records the issuer it registered at (ISS-913): the origin its registration request
-- reached, which is the origin of the `/.well-known/oauth-authorization-server` document that named
-- its `registration_endpoint`. The consent answers `iss` (RFC 9207) from it, never from the origin
-- the consent was posted through, which is the web's. No backfill: a client registered before this
-- migration has no recorded issuer, and its consent is refused MCP_AUTH_CLIENT_ISSUER_UNRECORDED,
-- telling it to register again.
--
-- ROLLBACK: ALTER TABLE "mcp_oauth_clients" DROP COLUMN IF EXISTS "issuer";
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "issuer" text;
