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

// cm:guard `(run_id, idempotency_key)` and NEVER the key alone. The key an agent mints is scoped to the run it is working — two runs retrying "deploy-1" are two different acts on two different rosters, and a global unique would silently fold the second into the first's row, which is a release reading somebody else's readings.
// cm:guard the machine columns and the agent's column are SEPARATE and neither is derived from the other. `account` is what the agent says happened; `health`, `identity`, `verdict` and `readings` are what core read. The whole defect this table answers is that those two were one sentence, so a schema that let an agent write into the machine half would put it back — the route refuses those keys, and this comment is why.
// cm:guard `settled_at` NULL is a real state and not a missing row: it is an act that was declared and never reported back, which is what a killed release looks like from outside. A reader that treats it as absent hides exactly the attempts worth looking at.
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
    // cm:guard the pair is what separates "short output" from "output the machine cut". A truncation nobody is told about reads as the whole of it, and an operator debugging a failed deploy then believes they have seen the error.
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
