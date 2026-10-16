-- An MCP client (Claude Code) signs in to /mcp through the browser instead of carrying a pasted
-- token. A client registers itself (mcp_oauth_clients), the person's consent issues a single-use
-- code bound to a PKCE challenge (mcp_oauth_codes), and the code is redeemed for a grant whose
-- refresh token rotates on every use (mcp_oauth_grants). The access token is a personal access
-- token that lives an hour, so /mcp authenticates it as it does any other.
--
-- ROLLBACK: drop the three tables, codes and grants before clients; every access token they minted
-- expires within the hour and stays revocable on the tokens page.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "created_ip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scopes" text[] NOT NULL,
  "project_ids" uuid[],
  "permissions" text[] NOT NULL,
  "grant_epoch" integer NOT NULL,
  "resource" text,
  "current_token_id" uuid REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL,
  "refresh_hash" text NOT NULL,
  "previous_refresh_hash" text,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "refreshed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_grants_refresh_uq" ON "mcp_oauth_grants" ("refresh_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_previous_idx" ON "mcp_oauth_grants" ("previous_refresh_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_user_client_idx" ON "mcp_oauth_grants" ("user_id", "client_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL,
  "client_id" uuid NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "resource" text,
  "scopes" text[] NOT NULL,
  "project_ids" uuid[],
  "permissions" text[] NOT NULL,
  "grant_epoch" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "grant_id" uuid REFERENCES "mcp_oauth_grants"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_codes_code_uq" ON "mcp_oauth_codes" ("code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_codes_expires_idx" ON "mcp_oauth_codes" ("expires_at");
