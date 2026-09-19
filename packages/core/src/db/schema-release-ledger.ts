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
    /** Core's verdict. NULL until the act reports back. */
    verdict: text('verdict').$type<'ok' | 'failed'>(),
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
