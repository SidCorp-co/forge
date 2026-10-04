import { PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { relations, sql } from 'drizzle-orm';
import { type AnyPgColumn, bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import * as axes from './release-axes.js';
import { agentSessions } from './schema-agent-sessions.js';
import { issues } from './schema-issues.js';
import { jobs } from './schema-jobs.js';
import { projects } from './schema-projects.js';

export const pipelineRunKinds = ['issue', 'interactive', 'system'] as const;

export type PipelineRunKind = (typeof pipelineRunKinds)[number];

export const pipelineRunStatuses = PIPELINE_RUN_STATUSES;

export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references((): AnyPgColumn => issues.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind', { enum: pipelineRunKinds }).notNull().default('issue'),
    status: text('status', { enum: pipelineRunStatuses }).notNull().default('running'),
    currentStep: text('current_step'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    /** A release's version and its ship (ISS-1120); both NULL on every other kind of run. */
    ...axes.releaseRunVersionColumns,
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectStatusIdx: index('pipeline_runs_project_status_idx').on(t.projectId, t.status),
    issueIdx: index('pipeline_runs_issue_idx').on(t.issueId),
    projectStartedAtIdx: index('pipeline_runs_started_at_idx').on(t.projectId, t.startedAt),
    startedAtIdx: index('pipeline_runs_started_at_only_idx').on(t.startedAt),
    issueOpenUq: uniqueIndex('pipeline_runs_issue_open_uq')
      .on(t.issueId)
      .where(sql`kind = 'issue' AND status IN ('running','paused')`),
    ...axes.releaseRunIdentity(t),
  }),
);

export const pipelineRunsRelations = relations(pipelineRuns, ({ one, many }) => ({
  project: one(projects, { fields: [pipelineRuns.projectId], references: [projects.id] }),
  issue: one(issues, { fields: [pipelineRuns.issueId], references: [issues.id] }),
  jobs: many(jobs),
  agentSessions: many(agentSessions),
}));

/**
 * Per-issue per-pipeline-run structured context (proposal Y).
 *
 * Stores the typed payload an agent writes at the end of a pipeline step
 * (kind='handoff') so the next state's prompt can inject it instead of
 * re-fetching the raw issue description / plan. Generic `kind` discriminator
 * leaves room for future per-issue per-run artifacts (blocker notes,
 * retrospectives, cross-step decisions) without another table.
 *
 * Lifecycle is fully derived: cascade delete from issues OR pipeline_runs.
 * No embedding here — handoffs are queried by natural key
 * `(issue_id, step, attempt)` in the hot path, not by similarity.
 *
 * Partial unique constraint enforces (issue, step, attempt) uniqueness for
 * `kind='handoff'` rows only; future kinds can have multiple rows per
 * (issue, step, attempt) without contention.
 */
export const issueStepContextKinds = ['handoff'] as const;

export type IssueStepContextKind = (typeof issueStepContextKinds)[number];

export const testResults = ['pass', 'fail', 'blocked_fixture', 'verified_by_test'] as const;

export const stepVerdicts = [...testResults, 'needs_fix', 'no_change', 'abstain'] as const;

export type StepVerdict = (typeof stepVerdicts)[number];

export const issueStepContexts = pgTable(
  'issue_step_contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references((): AnyPgColumn => issues.id, { onDelete: 'cascade' }),
    pipelineRunId: uuid('pipeline_run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    step: text('step'),
    attempt: integer('attempt').notNull().default(1),
    payload: jsonb('payload').notNull(),
    // ISS-381 (2.1) — nullable; set only for review/test handoffs. Powers the
    // pass_rate / approve_rate timeseries reads (migration 0094).
    verdict: text('verdict', { enum: stepVerdicts }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    handoffUq: uniqueIndex('issue_step_contexts_handoff_uq')
      .on(t.issueId, t.step, t.attempt)
      .where(sql`${t.kind} = 'handoff'`),
    issueKindIdx: index('issue_step_contexts_issue_kind_idx').on(t.issueId, t.kind),
    runIdx: index('issue_step_contexts_run_idx').on(t.pipelineRunId),
    verdictIdx: index('issue_step_contexts_verdict_idx')
      .on(t.projectId, t.step, t.createdAt)
      .where(sql`${t.verdict} IS NOT NULL`),
  }),
);

// ISS-381 (2.2) — per-project queue-depth snapshots written once per pipeline
// sweeper tick (runPipelineSweep) for projects with active jobs. Sparse: a tick
// with no active jobs for a project writes no row; the read gap-fills as 0.
export const queueSnapshots = pgTable(
  'queue_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    queueDepth: integer('queue_depth').notNull(),
    runningCount: integer('running_count').notNull(),
    avgWaitMs: bigint('avg_wait_ms', { mode: 'number' }),
  },
  (t) => ({
    projectTsIdx: index('queue_snapshots_project_ts_idx').on(t.projectId, t.ts),
  }),
);
