import { MASTER_JOB_PANES_MAX } from '@forge/contracts/master-standing';
import { type InferSelectModel, relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { devicePlatforms, deviceStatuses } from './device-vocabulary.js';
import { users } from './schema-auth.js';
import { jobs } from './schema-jobs.js';
import { projects } from './schema-projects.js';

export const deviceLoginCodes = pgTable(
  'device_login_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    deviceLabel: text('device_label').notNull(),
    devicePlatform: text('device_platform').notNull(),
    deviceHostname: text('device_hostname'),
    /** sha256 of `/etc/machine-id`, carried init→approve→issue so browser-approve dedups by machine like the paste-code flow. */
    machineId: text('machine_id'),
    createdIp: text('created_ip'),
    createdUserAgent: text('created_user_agent'),
    approvedUserId: uuid('approved_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('device_login_codes_expires_idx').on(t.expiresAt),
    consumedIdx: index('device_login_codes_consumed_idx').on(t.consumedAt),
  }),
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    platform: text('platform', { enum: devicePlatforms }).notNull(),
    agentVersion: text('agent_version'),
    agentCommit: text('agent_commit'),
    status: text('status', { enum: deviceStatuses }).notNull().default('offline'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    capabilities: jsonb('capabilities'),
    /**
     * The last declaration-gate condition this box reported, with the time core
     * heard it. Not `capabilities`: that is what a box declares it CAN do, this
     * is the condition it is IN (ISS-1192).
     */
    gateReport: jsonb('gate_report'),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    // cm:why the runner declares its job-pane ceiling and core holds no default (design agent-run-standing):
    // NULL is undeclared, served as such by masters/standing, never a guessed number
    maxJobPanes: integer('max_job_panes'),
    machineId: text('machine_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdIdx: index('devices_owner_id_idx').on(t.ownerId),
    ownerMachineIdx: index('devices_owner_machine_idx').on(t.ownerId, t.machineId),
    maxJobPanesChk: check(
      'devices_max_job_panes_chk',
      sql`${t.maxJobPanes} IS NULL OR ${t.maxJobPanes} BETWEEN 1 AND ${sql.raw(String(MASTER_JOB_PANES_MAX))}`,
    ),
  }),
);

export const pairingCodes = pgTable(
  'pairing_codes',
  {
    code: text('code').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    grantEpoch: integer('grant_epoch').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('pairing_codes_user_id_idx').on(t.userId),
    projectIdIdx: index('pairing_codes_project_id_idx').on(t.projectId),
    expiresAtIdx: index('pairing_codes_expires_at_idx').on(t.expiresAt),
  }),
);

/** A registered box, as every device-authenticated surface reads it. */
export type Device = InferSelectModel<typeof devices>;

export const devicesRelations = relations(devices, ({ one, many }) => ({
  owner: one(users, { fields: [devices.ownerId], references: [users.id] }),
  jobs: many(jobs),
}));

export const pairingCodesRelations = relations(pairingCodes, ({ one }) => ({
  user: one(users, { fields: [pairingCodes.userId], references: [users.id] }),
}));
