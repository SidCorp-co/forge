import { sql } from 'drizzle-orm';
import {
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
 * Who wrote the row. `agent` narrates its own progress over REST; `system` is
 * core deriving a row from kernel state it observed itself. `runner` stays in
 * the enum because rows carrying it exist; nothing writes it any more.
 */
export const phaseJournalSources = ['runner', 'agent', 'system'] as const;
export type PhaseJournalSource = (typeof phaseJournalSources)[number];

export const phaseJournalOutcomes = ['ok', 'failed', 'abandoned'] as const;
export type PhaseJournalOutcome = (typeof phaseJournalOutcomes)[number];

/**
 * A phase's structured result. `kind` is what makes a row machine-readable
 * rather than prose.
 */
export type PhaseArtifact =
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
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    agentSessionId: uuid('agent_session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),

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
    oneRowPerAttempt: uniqueIndex('phase_journal_run_phase_attempt_idx').on(
      t.runId,
      t.phase,
      t.attempt,
    ),
    runStartedIdx: index('phase_journal_run_started_idx').on(t.runId, t.startedAt),
    issueStartedIdx: index('phase_journal_issue_started_idx').on(t.issueId, t.startedAt),
    runnerVerdictsIdx: index('phase_journal_runner_verdicts_idx')
      .on(t.runId, t.startedAt)
      .where(sql`source = 'runner' AND artifact ->> 'kind' = 'verdict'`),
  }),
);

export type PhaseJournalRow = typeof phaseJournal.$inferSelect;
export type NewPhaseJournalRow = typeof phaseJournal.$inferInsert;
