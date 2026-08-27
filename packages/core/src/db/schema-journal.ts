// Phase journal — the durable record of what a pipeline attempt actually did,
// one row per phase per attempt (agent-driven pipeline, phase 2).
//
// It exists because the six-status vocabulary deliberately stops describing
// process position: `running` says a session holds the issue, nothing more.
// The journal carries the detail that `status` used to imply, without letting
// that detail gate anything — no dispatcher reads this table.
//
// Two consumers: the resume point after a session dies, and the metrics that
// `pipeline_run_step_durations` used to derive from one job row per step.
// Staged-mode jobs write here too, so a baseline accrues before there is an
// autonomous mode to compare against.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions, issues, jobs, pipelineRuns, projects } from './schema.js';

/**
 * Who wrote the row. The distinction is the whole integrity story: an agent may
 * narrate its own progress, but a result that judges the agent's work must come
 * from the runner, out of a structured return value the agent never touched.
 * `system` is core deriving a row from kernel state it observed itself — the
 * most trustworthy of the three, and how staged-mode history is reconstructed.
 */
export const phaseJournalSources = ['runner', 'agent', 'system'] as const;
export type PhaseJournalSource = (typeof phaseJournalSources)[number];

export const phaseJournalOutcomes = ['ok', 'failed', 'abandoned'] as const;
export type PhaseJournalOutcome = (typeof phaseJournalOutcomes)[number];

/**
 * A phase's structured result. `kind` is what makes a row machine-readable
 * rather than prose: `verdict` rows carry a review decision and are the ones
 * the CHECK constraint below refuses from an agent.
 */
export type PhaseArtifact =
  | { kind: 'verdict'; decision: 'approve' | 'request_changes' | 'abstain'; findings?: unknown[] }
  | { kind: 'commit'; sha: string; message?: string }
  | { kind: 'note'; text: string }
  | Record<string, unknown>;

export const phaseJournal = pgTable(
  'phase_journal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    // cm:why nullable exactly where pipeline_runs.issue_id is — pm/interactive/system runs have phases but no issue, and NOT NULL here would silently drop them from every metric built on this table
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),

    /** Agent-declared, free vocabulary. No gate reads this — see the module header. */
    phase: text('phase').notNull(),
    /** Round number for a phase entered more than once (review sent code back). */
    attempt: integer('attempt').notNull().default(1),
    source: text('source', { enum: phaseJournalSources }).notNull(),
    outcome: text('outcome', { enum: phaseJournalOutcomes }),
    artifact: jsonb('artifact').$type<PhaseArtifact>(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    // cm:guard a verdict judges the agent, so the agent may not author one — without this the driver can paraphrase request_changes into an approval, and no job boundary remains between coding and review to contradict it
    verdictIsRunnerWritten: check(
      'phase_journal_verdict_is_runner_written',
      sql`${t.artifact}->>'kind' IS DISTINCT FROM 'verdict' OR ${t.source} = 'runner'`,
    ),
    // cm:guard one row per (run, phase, attempt) — resume reads the latest unfinished phase, and a duplicate makes "where did it stop" ambiguous exactly when the session has died and cannot be asked
    oneRowPerAttempt: uniqueIndex('phase_journal_run_phase_attempt_idx').on(
      t.runId,
      t.phase,
      t.attempt,
    ),
    runStartedIdx: index('phase_journal_run_started_idx').on(t.runId, t.startedAt),
    issueStartedIdx: index('phase_journal_issue_started_idx').on(t.issueId, t.startedAt),
  }),
);

export type PhaseJournalRow = typeof phaseJournal.$inferSelect;
export type NewPhaseJournalRow = typeof phaseJournal.$inferInsert;
