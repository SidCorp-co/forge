import { isNull, sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { projects } from './schema-projects.js';

export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 18 }).notNull(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['read','write']::text[]`),
    projectIds: uuid('project_ids').array(),
    boundProjectId: uuid('bound_project_id').references(() => projects.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    permissions: text('permissions').array(),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    rateLimitMax: integer('rate_limit_max'),
    /**
     * The person this credential was handed to act for, where it is not a token its holder minted
     * for themselves: a turn's token acts for the person it answers, a box's for whoever paired it.
     * Every act made with it records this beside the token (`permissions/actor.ts:Actor`).
     */
    onBehalfOf: uuid('on_behalf_of').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    userNameUq: uniqueIndex('pat_user_name_uniq').on(t.userId, t.name).where(isNull(t.revokedAt)),
    userActiveIdx: index('pat_user_active_idx').on(t.userId, t.revokedAt),
    tokenPrefixIdx: index('pat_token_prefix_idx').on(t.tokenPrefix),
    deviceIdIdx: index('pat_device_id_idx').on(t.deviceId),
    liveNameIdx: index('pat_live_name_idx').on(t.name).where(isNull(t.revokedAt)),
  }),
);

export const mcpAuditLog = pgTable(
  'mcp_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => personalAccessTokens.id, {
      onDelete: 'set null',
    }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    action: text('action'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    resultCode: text('result_code').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    payloadDigest: varchar('payload_digest', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdIdx: index('mcp_audit_token_idx').on(t.tokenId, t.createdAt),
    userIdx: index('mcp_audit_user_idx').on(t.userId, t.createdAt),
    projectIdx: index('mcp_audit_project_idx').on(t.projectId, t.createdAt),
  }),
);
