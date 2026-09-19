import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { memories, memorySources, projects } from './schema.js';

export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source', { enum: memorySources }).notNull(),
    sourceRef: text('source_ref').notNull(),
    textContent: text('text_content').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    replacedAt: timestamp('replaced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memoryReplacedIdx: index('memory_revisions_memory_replaced_idx').on(t.memoryId, t.replacedAt),
    projectRefIdx: index('memory_revisions_project_ref_idx').on(t.projectId, t.sourceRef),
  }),
);
