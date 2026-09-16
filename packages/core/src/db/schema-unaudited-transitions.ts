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
