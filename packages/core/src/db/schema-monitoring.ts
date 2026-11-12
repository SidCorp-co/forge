import type { MonitoringReadiness } from '@forge/contracts/monitoring';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { integrationConnections } from './schema-integrations.js';
import { projects } from './schema-projects.js';

/**
 * A project's monitoring agent token (ISS-1225): the bearer its host's Prometheus agent remote-writes
 * to `POST /api/monitoring/write` with. One per project, minted by a holder of `project.admin`, shown
 * once and kept as the SHA-256 of its secret; a new one replaces the old (`monitoring/agent-tokens.ts`).
 */
export const monitoringAgentTokens = pgTable(
  'monitoring_agent_tokens',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** The secret's first characters, so a holder can tell which token a host carries. */
    prefix: text('prefix').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUq: uniqueIndex('monitoring_agent_tokens_token_hash_uq').on(t.tokenHash),
    tokenHashChk: check(
      'monitoring_agent_tokens_token_hash_chk',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

/**
 * What Forge holds of a monitoring connection beside the connection row (ISS-1225): the readiness
 * last read from its server's status API, and the two tokens Forge minted for it, each kept as the
 * SHA-256 of its secret and shown once: `sd` admits its Prometheus to the targets and rules doors,
 * `alerts` its Alertmanager to the alerts door. A new one replaces the old.
 */
export const monitoringConnections = pgTable(
  'monitoring_connections',
  {
    connectionId: uuid('connection_id')
      .primaryKey()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    readiness: jsonb('readiness').$type<MonitoringReadiness>(),
    sdTokenHash: text('sd_token_hash'),
    sdTokenPrefix: text('sd_token_prefix'),
    sdTokenCreatedAt: timestamp('sd_token_created_at', { withTimezone: true }),
    alertsTokenHash: text('alerts_token_hash'),
    alertsTokenPrefix: text('alerts_token_prefix'),
    alertsTokenCreatedAt: timestamp('alerts_token_created_at', { withTimezone: true }),
  },
  (t) => ({
    sdTokenHashUq: uniqueIndex('monitoring_connections_sd_token_hash_uq').on(t.sdTokenHash),
    alertsTokenHashUq: uniqueIndex('monitoring_connections_alerts_token_hash_uq').on(
      t.alertsTokenHash,
    ),
    tokenHashChk: check(
      'monitoring_connections_token_hash_chk',
      sql`(${t.sdTokenHash} IS NULL OR ${t.sdTokenHash} ~ '^[0-9a-f]{64}$') AND (${t.alertsTokenHash} IS NULL OR ${t.alertsTokenHash} ~ '^[0-9a-f]{64}$')`,
    ),
  }),
);
