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
