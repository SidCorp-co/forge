import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';

/** What memory's upkeep did: a release's reconcile, a consolidation sweep, a person deleting a memory for good, or a landing's re-check (ISS-1121). */
export const memoryUpkeepKinds = ['reconcile', 'consolidation', 'deletion', 'recheck'] as const;

/**
 * Core's record of its own memory upkeep, kept as history and never as memory (REQ-89 BC-3): no
 * memory list, count or recall reads it. A reconcile reads its own record here to run once per issue.
 */
export const memoryUpkeepRecords = pgTable(
  'memory_upkeep_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: memoryUpkeepKinds }).notNull(),
    ref: text('ref').notNull(),
    textContent: text('text_content').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectRefUq: uniqueIndex('memory_upkeep_records_project_ref_uq').on(t.projectId, t.ref),
    kindChk: check(
      'memory_upkeep_records_kind_chk',
      sql`${t.kind} IN ('reconcile', 'consolidation', 'deletion', 'recheck')`,
    ),
  }),
);
