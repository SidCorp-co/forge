import { RUNNER_PROVISION_STATUSES, RUNNER_STATUSES } from '@forge/contracts/runner-machine';
import { relations } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './schema-devices.js';
import { jobs } from './schema-jobs.js';
import { labels } from './schema-labels.js';
import { projects } from './schema-projects.js';

// EPIC 2 (ISS-271) — Runner framework.
// A `runner` is a capability handle the dispatcher targets; concrete behaviour
// lives in a `RunnerAdapter` registered by `bootstrapRunnerAdapters()`.
// EPIC 2 owns the schema. EPIC 3 Phase B (ISS-272 follow-up) layers admin
// dashboard reads on top — do not redesign these columns there.
export const runnerTypes = ['claude-code'] as const;

export type RunnerType = (typeof runnerTypes)[number];

export const runnerStatuses = RUNNER_STATUSES;

export const runnerLimitReasons = ['usage_limit', 'rate_limit', 'auth'] as const;

export type RunnerLimitReason = (typeof runnerLimitReasons)[number];

// Per (device × project) workspace provisioning lifecycle: `@forge/contracts/runner-machine:RUNNER_PROVISION_MACHINE`.
export const runnerProvisionStatuses = RUNNER_PROVISION_STATUSES;

export type RunnerProvisionStatus = (typeof runnerProvisionStatuses)[number];

export type RunnerStatus = (typeof runnerStatuses)[number];

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', { enum: runnerTypes }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    labels: jsonb('labels').notNull().default([]),
    capabilities: jsonb('capabilities').notNull().default({}),
    config: jsonb('config').notNull().default({}),
    // ISS-271 — per (device × project) repo checkout: the only place a checkout is named, written
    // by web (PATCH) or CLI (`forge-runner bind`).
    repoPath: text('repo_path'),
    branch: text('branch'),
    status: text('status', { enum: runnerStatuses }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastError: text('last_error'),
    limitReason: text('limit_reason', { enum: runnerLimitReasons }),
    rateLimitedUntil: timestamp('rate_limited_until', { withTimezone: true }),
    limitDetail: text('limit_detail'),
    quarantinedUntil: timestamp('quarantined_until', { withTimezone: true }),
    quarantineReason: text('quarantine_reason'),
    // Per (device × project) workspace provisioning state. NULL = not yet
    // provisioned / legacy row. The runner advances this via the device
    // provision-status report; web renders it as a live stepper. `queued` is
    // the offline hand-off — a device that's offline picks the job up on next
    // connect (pull model), so bind never blocks on device presence.
    provisionStatus: text('provision_status', { enum: runnerProvisionStatuses }),
    // Human-readable last detail (clone error, "folder missing", skill count…).
    provisionDetail: text('provision_detail'),
    // When the current provision request was enqueued (queue ordering + re-run).
    provisionRequestedAt: timestamp('provision_requested_at', { withTimezone: true }),
    // When provision last reached a terminal `ready`.
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
    // The box's failed reads of this project's job pool, off the heartbeat (ISS-1234).
    poolRead: jsonb('pool_read'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectTypeStatusIdx: index('runners_project_type_status_idx').on(
      t.projectId,
      t.type,
      t.status,
    ),
    projectDeviceTypeUq: uniqueIndex('runners_project_device_type_uq').on(
      t.projectId,
      t.deviceId,
      t.type,
    ),
  }),
);

export const runnersRelations = relations(runners, ({ one, many }) => ({
  project: one(projects, { fields: [runners.projectId], references: [projects.id] }),
  device: one(devices, { fields: [runners.deviceId], references: [devices.id] }),
  jobs: many(jobs),
}));

// ISS-381 (2.3) — runner status-change audit, one row per transition written by
// `runners/runner-events.ts:setRunnerStatus`, so it records what was DECIDED
// about a runner and never an actor of `runners.status`. old_status is
// nullable for the initial bind/create event.
export const runnerEvents = pgTable(
  'runner_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runnerId: uuid('runner_id')
      .notNull()
      .references((): AnyPgColumn => runners.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    oldStatus: text('old_status'),
    newStatus: text('new_status').notNull(),
    reason: text('reason'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runnerTsIdx: index('runner_events_runner_ts_idx').on(t.runnerId, t.ts),
    projectTsIdx: index('runner_events_project_ts_idx').on(t.projectId, t.ts),
  }),
);
