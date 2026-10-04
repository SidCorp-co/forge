import { relations, type SQL, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';
import { identSearchColumn, MEMORY_EMBEDDING_DIM, pgVector, tsVector } from './schema-types.js';

export const knowledgeKinds = [
  'overview',
  'scenario',
  'workflow',
  'rule',
  'guide',
  'reference',
  'glossary',
] as const;

export const knowledgeEntries = pgTable(
  'knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: knowledgeKinds }).notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    injection: text('injection', { enum: ['always', 'on_demand', 'none'] })
      .notNull()
      .default('on_demand'),
    /**
     * When this entry is worth reading, or `null` where nobody has said
     * (ISS-1313). `{ verbs?: MasterVerb[], statuses?: IssueStatus[] }`, held to
     * that shape by `knowledge_entries_read_when_chk`. It is a second axis
     * beside `injection` and not a replacement for it: `injection` decides
     * whether an entry is carried into every prompt, and this decides whether
     * it is worth fetching for the act in hand. Never a file glob — a master
     * dispatches and moves issues rather than editing files.
     */
    readWhen: jsonb('read_when'),
    confidence: text('confidence', { enum: ['verified', 'inferred', 'deprecated'] })
      .notNull()
      .default('inferred'),
    relatedIssueIds: jsonb('related_issue_ids').notNull().default([]),
    tags: jsonb('tags').notNull().default([]),
    orderIndex: integer('order_index').notNull().default(0),
    authoredBy: text('authored_by', { enum: ['human', 'agent', 'imported'] })
      .notNull()
      .default('agent'),
    embedding: pgVector(MEMORY_EMBEDDING_DIM)('embedding'),
    textSearch: tsVector('text_search').generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', left(${knowledgeEntries.title} || ' ' || ${knowledgeEntries.body}, 100000))`,
    ),
    identSearch: identSearchColumn(
      (): SQL => sql`left(${knowledgeEntries.title} || ' ' || ${knowledgeEntries.body}, 100000)`,
    ),
    metadata: jsonb('metadata').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectKindIdx: index('knowledge_entries_project_kind_idx').on(t.projectId, t.kind),
    projectSlugUq: uniqueIndex('knowledge_entries_project_slug_uq').on(t.projectId, t.slug),
    embeddingHnswIdx: index('knowledge_entries_embedding_hnsw_idx').using(
      'hnsw',
      sql`"embedding" vector_cosine_ops`,
    ),
    textSearchIdx: index('knowledge_entries_text_search_idx').using('gin', t.textSearch),
    identSearchIdx: index('knowledge_entries_ident_search_idx').using('gin', t.identSearch),
    embeddingBackfillIdx: index('knowledge_entries_embedding_backfill_idx')
      .on(t.updatedAt)
      .where(sql`embedding IS NULL AND archived_at IS NULL`),
    // Mirrors `parseReadWhen` (ISS-1313); declared here too so drizzle-kit's model has it.
    readWhenChk: check(
      'knowledge_entries_read_when_chk',
      sql`knowledge_read_when_ok(${t.readWhen})`,
    ),
  }),
);

export const knowledgeEntriesRelations = relations(knowledgeEntries, ({ one }) => ({
  project: one(projects, { fields: [knowledgeEntries.projectId], references: [projects.id] }),
}));
