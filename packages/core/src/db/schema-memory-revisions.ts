// ISS-790. The previous body of a memory row, kept when a write replaced it.
//
// After ISS-876 removed the dedup absorb (and with it `archiveSupersededText`,
// the only thing that had ever recorded a replacement), an exact-key re-write
// is the ONLY path by which one memory's text replaces another's — and it is
// the path both preambles instruct agents to take ("reusing a `sourceRef`
// refines the existing note"). Nothing recorded that. The four wrong-day rows
// repaired on 2026-09-05 were recoverable only because the deleted absorb had
// left archived snapshots behind; a repeat today would have nothing to read.
//
// Split out of `schema.ts` for size, like `schema-memory-chunks.ts`, and
// registered in `drizzle.config.ts` and the drizzle client's schema map.

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { memories, memorySources, projects } from './schema.js';

// cm:edge sideeffect -> packages/core/drizzle/migrations/0208_memory_revisions.sql — rows here are written by the `memories_record_replacement` trigger and by nothing in TypeScript; a reader who greps for an INSERT into this table finds none, and a checker that trusts the grep concludes the table is dead
// cm:edge contract -> packages/core/src/memory/write-service.ts#AGENT_AUTHORED_SOURCES — the trigger's `NEW.source IN ('note','knowledge','policy')` is that same set written in SQL, where nothing type-checks it. Lifecycle mirrors (issue/comment/job/decision) are excluded on purpose: their text mirrors a record that keeps its own history, and an issue-description edit would otherwise mint a revision row on every keystroke-sized save, forever, in a table nobody reads
// cm:guard a revision is written only when `text_content` actually CHANGED — the embedding backfill, `feedback` and a re-write of identical text must leave no trace, or the history stops meaning "someone replaced this"
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
