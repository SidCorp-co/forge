import { relations, sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import {
  agentSessionFailureReasons,
  agentSessionKinds,
  agentSessionStatuses,
  sessionRuntimeStates,
} from './session-vocabulary.js';

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // ISS-101 — every agent_session belongs to a pipeline_run. Pipeline jobs
    // inherit the parent job's run; user-driven chat sessions get a one-shot
    // 'interactive' run each. NOT NULL is enforced at the DB level by 0054.
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'restrict' }),
    title: text('title'),
    status: text('status', { enum: agentSessionStatuses }).notNull().default('idle'),
    messages: jsonb('messages').notNull().default(sql`'[]'::jsonb`),
    claudeSessionId: text('claude_session_id'),
    repoPath: text('repo_path'),
    usage: jsonb('usage'),
    metadata: jsonb('metadata'),
    kind: text('kind', { enum: agentSessionKinds }).notNull(),
    /** Who owns this session, as CORE issued it — never as a box reported it. */
    parentSessionId: uuid('parent_session_id'),
    diff: jsonb('diff'),
    pipelineControl: jsonb('pipeline_control').$type<
      import('@forge/contracts/pipeline-control').PipelineControl | null
    >(),
    pipelineTelemetry: jsonb('pipeline_telemetry'),
    pipelineHealth: jsonb('pipeline_health').$type<
      import('@forge/contracts/pipeline-control').PipelineHealth | null
    >(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    failureReason: text('failure_reason', { enum: agentSessionFailureReasons }),
    failureDetail: text('failure_detail'),
    runtimeState: text('runtime_state', { enum: sessionRuntimeStates }),
    lastInboxSeq: integer('last_inbox_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('agent_sessions_project_status_idx').on(t.projectId, t.status),
    deviceIdx: index('agent_sessions_device_idx').on(t.deviceId),
    userIdx: index('agent_sessions_user_idx').on(t.userId),
    statusHeartbeatIdx: index('agent_sessions_status_heartbeat_idx').on(
      t.status,
      t.lastHeartbeatAt,
    ),
    statusDispatchedIdx: index('agent_sessions_status_dispatched_idx').on(t.status, t.dispatchedAt),
    pipelineRunIdx: index('agent_sessions_pipeline_run_idx').on(t.pipelineRunId),
    kindStatusIdx: index('agent_sessions_kind_status_idx').on(t.kind, t.status),
    // One live master per (device, project) was an intention held by a select
    // running before an insert. This makes it a fact; `ensureMasterSession`
    // keeps an advisory lock so the loser waits rather than raising.
    oneLiveMasterUq: uniqueIndex('agent_sessions_one_live_master_uq')
      .on(t.deviceId, t.projectId)
      .where(
        sql`kind = 'master' AND status NOT IN ('completed', 'failed', 'completed_via_recovery', 'cancelled_stale', 'cancelled')`,
      ),
    parentIdx: index('agent_sessions_parent_idx').on(t.parentSessionId),
    parentFk: foreignKey({
      columns: [t.parentSessionId],
      foreignColumns: [t.id],
      name: 'agent_sessions_parent_session_id_fkey',
    }).onDelete('set null'),
  }),
);

export const agentSessionsRelations = relations(agentSessions, ({ many, one }) => ({
  project: one(projects, { fields: [agentSessions.projectId], references: [projects.id] }),
  user: one(users, { fields: [agentSessions.userId], references: [users.id] }),
  device: one(devices, { fields: [agentSessions.deviceId], references: [devices.id] }),
  pipelineRun: one(pipelineRuns, {
    fields: [agentSessions.pipelineRunId],
    references: [pipelineRuns.id],
  }),
  turns: many(agentSessionTurns),
}));

// Sibling table that materializes each entry of `agent_sessions.messages` into
// its own row so turns can be addressed by id. The jsonb blob remains the
// source of truth during the dual-write rollout.
export const agentSessionTurnRoles = ['user', 'assistant', 'tool'] as const;

export type AgentSessionTurnRole = (typeof agentSessionTurnRoles)[number];

export const agentSessionTurns = pgTable(
  'agent_session_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    turnIndex: integer('turn_index').notNull(),
    role: text('role', { enum: agentSessionTurnRoles }).notNull(),
    content: jsonb('content').notNull(),
    parentTurnId: uuid('parent_turn_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => ({
    sessionIndexUnique: uniqueIndex('agent_session_turns_session_index_unique').on(
      t.agentSessionId,
      t.turnIndex,
    ),
    parentIdx: index('agent_session_turns_parent_idx').on(t.parentTurnId),
  }),
);

export const agentSessionTurnsRelations = relations(agentSessionTurns, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionTurns.agentSessionId],
    references: [agentSessions.id],
  }),
  parent: one(agentSessionTurns, {
    fields: [agentSessionTurns.parentTurnId],
    references: [agentSessionTurns.id],
    relationName: 'agent_session_turns_parent',
  }),
}));

export const sessionAttachments = pgTable(
  'session_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    uploaderDeviceId: uuid('uploader_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('session_attachments_session_id_idx').on(t.sessionId),
    uploaderDeviceIdx: index('session_attachments_uploader_device_id_idx').on(t.uploaderDeviceId),
  }),
);

export const sessionAttachmentsRelations = relations(sessionAttachments, ({ one }) => ({
  session: one(agentSessions, {
    fields: [sessionAttachments.sessionId],
    references: [agentSessions.id],
  }),
  uploader: one(users, { fields: [sessionAttachments.uploaderId], references: [users.id] }),
  uploaderDevice: one(devices, {
    fields: [sessionAttachments.uploaderDeviceId],
    references: [devices.id],
  }),
}));
