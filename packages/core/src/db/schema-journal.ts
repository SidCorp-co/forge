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
import { phaseJournalOutcomes, phaseJournalSources } from './journal-vocabulary.js';
import { agentSessions, issues, jobs, pipelineRuns, projects } from './schema.js';

export * from './journal-vocabulary.js';

/**
 * A phase's structured result. `kind` is what makes a row machine-readable
 * rather than prose.
 */
export type PhaseArtifact =
  | { kind: 'commit'; sha: string; message?: string }
  | { kind: 'note'; text: string }
  | Record<string, unknown>;

/**
 * What a run did, one row per (run, phase, attempt) (ISS-1133). A session declares a phase, ends it
 * once, and may leave the attempt's handoff once; no column a row holds is written a second time,
 * which is what the stores' guarded UPDATEs keep and the two CHECKs below make whole.
 */
export const runJournal = pgTable(
  'run_journal',
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
    /** The attempt's step handoff, validated by `memory/step-handoff-schema.ts`. */
    handoff: jsonb('handoff').$type<Record<string, unknown>>(),
    /** When the handoff was written, which is what a job's completion is judged against. */
    handoffAt: timestamp('handoff_at', { withTimezone: true }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    oneRowPerAttempt: uniqueIndex('run_journal_run_phase_attempt_idx').on(
      t.runId,
      t.phase,
      t.attempt,
    ),
    runStartedIdx: index('run_journal_run_started_idx').on(t.runId, t.startedAt),
    issueStartedIdx: index('run_journal_issue_started_idx').on(t.issueId, t.startedAt),
    runnerVerdictsIdx: index('run_journal_runner_verdicts_idx')
      .on(t.runId, t.startedAt)
      .where(sql`source = 'runner' AND artifact ->> 'kind' = 'verdict'`),
    endIsWhole: check('run_journal_end_is_whole', sql`(ended_at IS NULL) = (outcome IS NULL)`),
    handoffIsWhole: check(
      'run_journal_handoff_is_whole',
      sql`(handoff IS NULL) = (handoff_at IS NULL)`,
    ),
  }),
);

export type RunJournalRow = typeof runJournal.$inferSelect;
export type NewRunJournalRow = typeof runJournal.$inferInsert;
