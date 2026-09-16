/**
 * `release_attempts` — every act a release run made, and what came back.
 *
 * Between `createReleaseBatch` and `finish` core recorded nothing at all. A
 * release that merged, deployed twice, failed a probe and deployed again left
 * one `pipeline_runs` row saying `running` and a transcript on whichever box
 * happened to hold it. Nobody could read what a release had done — not an
 * operator, not the next agent, and not `finish` itself, which is why the only
 * account of a release was the sentence the agent wrote about its own work.
 *
 * Split out of `schema.ts` for the reason `schema-run-ledger.ts` states: that
 * file is frozen far over the file budget, so a new table cannot land there
 * without an amnesty.
 */

import type { InferSelectModel } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { pipelineRuns } from './schema.js';

/** What an attempt was an attempt AT. */
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
    /** The agent's own key for this act, unique within the run. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The commit this act was about. */
    commit: text('commit'),
    /** The provider's handle on what it did — a Coolify deployment uuid, a tag. */
    providerRef: text('provider_ref'),
    /** Core's reading of whether the application answered. */
    health: text('health').$type<'up' | 'down'>(),
    /** Core's reading of what the application says it is serving. */
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
