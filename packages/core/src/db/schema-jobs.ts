import { JOB_STATUSES } from '@forge/contracts/job-machine';
import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { jobEventKinds } from './job-event-kinds.js';
import { users } from './schema-auth.js';
import { devices } from './schema-devices.js';
import { issues } from './schema-issues.js';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';
import { runners } from './schema-runners.js';

export const jobStatuses = JOB_STATUSES;

export type JobStatus = (typeof jobStatuses)[number];

export const jobTypes = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'staging',
  'release',
  'fix',
  'custom',
  'smoke',
  'release_batch',
  'drive',
  // cm:why the project-onboarding analysis (ISS-63): an issue-less job whose prompt carries the whole
  // method, so the runner, which never branches on the type, needs no change
  'onboarding',
] as const;

export type JobType = (typeof jobTypes)[number];

export const modelTiers = ['haiku', 'sonnet', 'opus'] as const;

export type ModelTier = (typeof modelTiers)[number];

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, { onDelete: 'set null' }),
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    runnerId: uuid('runner_id').references((): AnyPgColumn => runners.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type', { enum: jobTypes }).notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('queued'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    error: text('error'),
    modelTier: text('model_tier', { enum: modelTiers }),
    attempts: integer('attempts').notNull().default(1),
    cancellationRequested: boolean('cancellation_requested').notNull().default(false),
    killRequestedAt: timestamp('kill_requested_at', { withTimezone: true }),
    killConfirmedAt: timestamp('kill_confirmed_at', { withTimezone: true }),
    killOutcome: text('kill_outcome', {
      enum: ['killed', 'not_found', 'runner_gone', 'reported_terminal', 'never_claimed'],
    }),
    retryOf: uuid('retry_of').references((): AnyPgColumn => jobs.id, { onDelete: 'set null' }),
    // ISS-197 — when set, dispatch gate L1 skips this row until now() >=
    // retry_after_at. Written by the retry engine after a transient/timeout
    // failure with an optional provider Retry-After hint; NULL otherwise.
    retryAfterAt: timestamp('retry_after_at', { withTimezone: true }),
    agentSessionId: uuid('agent_session_id'),
    heldBy: uuid('held_by'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    // Pipeline self-healing (Phase H, ISS-306; taxonomy rebuilt by ISS-450 /
    // ISS-442 C4). Set when the job ends in `failed`. failureKind drives the
    // per-class retry policy (code = no retry, transient-cc = immediate
    // device failover, infra/timeout = bounded round-robin). classifierVersion
    // pins the classifier rules at write time so old rows survive future
    // pattern changes without silent reclassification.
    failureKind: text('failure_kind', {
      enum: ['code', 'infra', 'transient-cc', 'timeout'],
    }),
    failureAction: text('failure_action', {
      enum: ['terminal', 'quarantine', 'failover', 'retry'],
    }),
    failureReason: text('failure_reason'),
    failureMeta: jsonb('failure_meta'),
    classifierVersion: integer('classifier_version'),
    // S1.1 — Prompt snapshot for Inspector + Analytics. system_prompt_hash
    // points at prompt_blobs (content-addressable dedup, ~70% storage win);
    // user_prompt_snapshot is the rendered `/skill id + ## Issue + ## Prev
    // Session Context` string inline because every job is unique here.
    // prompt_blocks is the per-block char/token breakdown for analytics.
    // archive_path is set by the retention sweeper once the row ages past
    // FORGE_PROMPT_RETENTION_DAYS.
    systemPromptHash: text('system_prompt_hash').references((): AnyPgColumn => promptBlobs.hash),
    userPromptSnapshot: text('user_prompt_snapshot'),
    promptInputTokenEst: integer('prompt_input_token_est'),
    modelUsed: text('model_used'),
    promptBlocks: jsonb('prompt_blocks'),
    archivePath: text('archive_path'),
    skillsRanWith: jsonb('skills_ran_with'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdIdx: index('jobs_project_id_idx').on(t.projectId),
    deviceIdIdx: index('jobs_device_id_idx').on(t.deviceId),
    issueIdIdx: index('jobs_issue_id_idx').on(t.issueId),
    statusIdx: index('jobs_status_idx').on(t.status),
    runnerIdIdx: index('jobs_runner_id_idx').on(t.runnerId),
    retryOfIdx: index('jobs_retry_of_idx').on(t.retryOf),
    agentSessionIdIdx: index('jobs_agent_session_id_idx').on(t.agentSessionId),
    killRequestedAtIdx: index('jobs_kill_requested_at_idx')
      .on(t.status, t.killRequestedAt)
      .where(sql`kill_requested_at IS NOT NULL`),
    activeUniqueIdx: uniqueIndex('jobs_active_unique')
      .on(t.issueId, t.type)
      .where(sql`status IN ('queued','dispatched','held') AND issue_id IS NOT NULL`),
    pipelineRunIdx: index('jobs_pipeline_run_idx').on(t.pipelineRunId),
    finishedArchiveIdx: index('jobs_finished_archive_idx')
      .on(t.finishedAt)
      .where(sql`archive_path IS NULL AND finished_at IS NOT NULL`),
    // ISS-455 — a project's smoke canaries, kept off the hot jobs rows.
    smokeProjectQueuedIdx: index('jobs_smoke_project_queued_idx')
      .on(t.projectId, t.queuedAt)
      .where(sql`type = 'smoke'`),
  }),
);

// S1.1 — Content-addressable store for system prompts. Many jobs share the
// same preamble (PIPELINE_RULES + TOOL_REFERENCE + branches) so we keep
// one row per unique hash and reference-count via jobs.system_prompt_hash.
// GC happens when ref_count hits 0 during retention sweep.
export const promptBlobs = pgTable('prompt_blobs', {
  hash: text('hash').primaryKey(),
  content: text('content').notNull(),
  firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  refCount: integer('ref_count').notNull().default(0),
});

export const jobEvents = pgTable(
  'job_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: jobEventKinds }).notNull(),
    data: jsonb('data').notNull().default({}),
    seq: integer('seq').notNull(),
  },
  (t) => ({
    jobIdSeqIdx: uniqueIndex('job_events_job_id_seq_idx').on(t.jobId, t.seq),
    tsIdx: index('job_events_ts_idx').on(t.ts),
    jobIdTsIdx: index('job_events_job_id_ts_idx').on(t.jobId, t.ts),
    resultKindIdx: index('job_events_result_idx').on(t.jobId).where(sql`kind = 'result'`),
    secretResolveIdx: index('job_events_secret_resolve_idx')
      .on(t.jobId)
      .where(sql`kind = 'secret_resolve'`),
  }),
);

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  project: one(projects, { fields: [jobs.projectId], references: [projects.id] }),
  device: one(devices, { fields: [jobs.deviceId], references: [devices.id] }),
  runner: one(runners, { fields: [jobs.runnerId], references: [runners.id] }),
  createdByUser: one(users, { fields: [jobs.createdBy], references: [users.id] }),
  pipelineRun: one(pipelineRuns, {
    fields: [jobs.pipelineRunId],
    references: [pipelineRuns.id],
  }),
  events: many(jobEvents),
}));

export const jobEventsRelations = relations(jobEvents, ({ one }) => ({
  job: one(jobs, { fields: [jobEvents.jobId], references: [jobs.id] }),
}));
