import { OUTBOX_EVENT_TYPES } from '@forge/contracts/outbox-events';
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// The one durable outbox (pattern v2 BC-18): one row per event, written in the transaction of the
// act it reports (`outbox/emit.ts:emitEvents`) with one pg-boss job per consumer. `seq` is folded
// into each job's id, so an issue's events written in one transaction keep their order.
export const pipelineOutbox = pgTable(
  'pipeline_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    type: text('type', { enum: OUTBOX_EVENT_TYPES }).notNull(),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeChk: check('pipeline_outbox_type_chk', sql`${t.type} IN (${inList(OUTBOX_EVENT_TYPES)})`),
    createdIdx: index('pipeline_outbox_created_idx').on(t.createdAt),
  }),
);
