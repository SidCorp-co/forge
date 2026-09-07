/**
 * `unaudited_transitions` — the terminal status flips that never reached
 * `kernel_transitions` at all, so the interventions metric counts a hand on the
 * database instead of only the hands that went through TypeScript (ISS-884).
 *
 * Split out of `schema.ts` for the reason `schema-admin-thresholds.ts` states:
 * that file is frozen far over the 500-line file budget and the `form` axis
 * declares `improves=down`, so a new table cannot land there without an amnesty
 * the gate refuses. `drizzle.config.ts` and `db/client.ts` each name this file.
 */

import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { kernelTransitionEntities } from './schema.js';

// cm:why written ONLY by the `forge_detect_unaudited_transition` trigger, when a terminal status lands on `jobs`/`pipeline_runs` in a transaction carrying no `forge.kernel_txn` marker. Denormalised with no FK to the flipped row on purpose: a hand that edits by SQL may delete by SQL, and the record of the intervention has to outlive the row it was performed on.
// cm:edge contract -> packages/core/drizzle/migrations/0217_unaudited_transition_detector.sql — the trigger INSERTs this column list positionally through `EXECUTE ... USING`, so reordering or renaming a column here without editing that function writes the wrong value into the wrong column and no type-check sees it.
// cm:guard nothing in TypeScript may INSERT here — a row this table holds means "no code wrote this flip", so a code path that writes one is claiming the opposite of what the row means. One index, and it is (project_id, detected_at): every read arrives through `issue_intervention_events`, which the analytics route filters by project and then by window, so an index on `detected_at` alone would be paid on every write and used by nothing.
export const unauditedTransitions = pgTable(
  'unaudited_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entity: text('entity', { enum: kernelTransitionEntities }).notNull(),
    entityId: uuid('entity_id').notNull(),
    projectId: uuid('project_id').notNull(),
    issueId: uuid('issue_id'),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    dbUser: text('db_user').notNull(),
    applicationName: text('application_name'),
    clientAddr: text('client_addr'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('unaudited_transitions_project_idx').on(t.projectId, t.detectedAt),
  }),
);
