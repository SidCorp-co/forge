import { OUTBOX_EVENT_TYPES } from '@forge/contracts/outbox-events';
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';

// Every type an outbox row may carry, one row each, held to OUTBOX_EVENT_TYPES by the boot's migrate
// step and by schema-checks.test.ts. A new event type is one INSERT migration, never a list rewrite.
export const outboxEventTypes = pgTable('outbox_event_types', {
  type: text('type').primaryKey(),
});

// The one durable outbox (pattern v2 BC-18): one row per event, written in the transaction of the
// act it reports (`outbox/emit.ts:emitEvents`) with one pg-boss job per consumer. `seq` is folded
// into each job's id, so an issue's events written in one transaction keep their order.
export const pipelineOutbox = pgTable(
  'pipeline_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedByDefaultAsIdentity(),
    type: text('type', { enum: OUTBOX_EVENT_TYPES })
      .notNull()
      .references(() => outboxEventTypes.type),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('pipeline_outbox_created_idx').on(t.createdAt),
  }),
);
