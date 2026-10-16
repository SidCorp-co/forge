import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { personalAccessTokens } from './schema-credentials.js';

/**
 * An MCP client that registered itself (RFC 7591), owned by the `credentials` platform module. A
 * public client: it holds no secret, so every code it redeems is bound to a PKCE challenge and to
 * one of the redirect URIs listed here.
 */
export const mcpOauthClients = pgTable('mcp_oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  createdIp: text('created_ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The reach one person gave one client on the consent page, carried by a refresh token that
 * rotates on every use. The access token of the moment is a personal access token
 * (`currentTokenId`); revoking it on the tokens page ends the grant at its next refresh.
 */
export const mcpOauthGrants = pgTable(
  'mcp_oauth_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull(),
    projectIds: uuid('project_ids').array(),
    permissions: text('permissions').array().notNull(),
    grantEpoch: integer('grant_epoch').notNull(),
    resource: text('resource'),
    currentTokenId: uuid('current_token_id').references(() => personalAccessTokens.id, {
      onDelete: 'set null',
    }),
    refreshHash: text('refresh_hash').notNull(),
    /** The refresh token this one replaced: presented again, it was stolen, and the grant ends. */
    previousRefreshHash: text('previous_refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mcp_oauth_grants_refresh_uq').on(t.refreshHash),
    index('mcp_oauth_grants_previous_idx').on(t.previousRefreshHash),
    index('mcp_oauth_grants_user_client_idx').on(t.userId, t.clientId),
  ],
);

/**
 * A code the consent page issued, redeemed once at the token endpoint by the client that asked
 * for it, from the redirect URI it named, with the verifier of its PKCE challenge.
 */
export const mcpOauthCodes = pgTable(
  'mcp_oauth_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    resource: text('resource'),
    scopes: text('scopes').array().notNull(),
    projectIds: uuid('project_ids').array(),
    permissions: text('permissions').array().notNull(),
    grantEpoch: integer('grant_epoch').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The grant this code was redeemed for: a second redemption ends it (RFC 6749 §4.1.2). */
    grantId: uuid('grant_id').references(() => mcpOauthGrants.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mcp_oauth_codes_code_uq').on(t.codeHash),
    index('mcp_oauth_codes_expires_idx').on(t.expiresAt),
  ],
);

export type McpOauthClientRow = typeof mcpOauthClients.$inferSelect;
export type McpOauthGrantRow = typeof mcpOauthGrants.$inferSelect;
export type McpOauthCodeRow = typeof mcpOauthCodes.$inferSelect;
