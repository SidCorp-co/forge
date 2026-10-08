import type { InferSelectModel } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { pipelineRuns } from './schema.js';

export const RELEASE_ATTEMPT_STAGES = ['promote', 'deploy', 'verify', 'repair'] as const;
export type ReleaseAttemptStage = (typeof RELEASE_ATTEMPT_STAGES)[number];

export const releaseAttempts = pgTable(
  'release_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<ReleaseAttemptStage>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commit: text('commit'),
    providerRef: text('provider_ref'),
    health: text('health').$type<'up' | 'down'>(),
    identity: text('identity'),
    /** Core's verdict. NULL until the act reports back; `unverified` where no probe was declared
     *  to read, which is neither a pass nor a red (ISS-1321). A text column, so no migration. */
    verdict: text('verdict').$type<'ok' | 'failed' | 'unverified'>(),
    /** Why the verdict, in core's words. */
    verdictReason: text('verdict_reason'),
    /** One line per probe, in declaration order, whatever the outcome. */
    readings: jsonb('readings').$type<string[]>(),
    /** The agent's own account of this act, stored beside the verdict. */
    account: text('account'),
    /** The tail of whatever the act printed. */
    logTail: text('log_tail'),
    logTailTruncated: boolean('log_tail_truncated').notNull().default(false),
    /** NULL means nobody has read past the cut. */
    logTailReadAt: timestamp('log_tail_read_at', { withTimezone: true }),
    logTailReadBy: uuid('log_tail_read_by'),
    /** When the intent was recorded — BEFORE the act it describes. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the act reported back. NULL means it never did. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    runKeyUq: unique('release_attempts_run_key_uq').on(t.runId, t.idempotencyKey),
    runIdx: index('release_attempts_run_idx').on(t.runId, t.startedAt),
  }),
);

export type ReleaseAttemptRow = InferSelectModel<typeof releaseAttempts>;

/**
 * What Forge read at a release's live deploy bindings when an agent asked it to look (ISS-1282).
 * A finish closes a probed roster on these rows and on nothing the agent says: `bindings` is one
 * `LiveState` per binding that declares a probe, and `unread` names the bindings that declare none.
 * Append-only; a row is never rewritten, because a reading is what was serving at `taken_at`.
 */
export const releaseReadings = pgTable(
  'release_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    /** Who asked for the look. The reading itself is Forge's, whoever asked. */
    takenBy: uuid('taken_by').notNull(),
    bindings: jsonb('bindings').notNull(),
    unread: jsonb('unread').notNull().default([]),
  },
  (t) => ({
    runIdx: index('release_readings_run_idx').on(t.runId, t.takenAt),
  }),
);

export type ReleaseReadingRow = InferSelectModel<typeof releaseReadings>;
