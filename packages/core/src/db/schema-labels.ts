import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issueLabels } from './schema-issues.js';
import { knowledgeEntries } from './schema-knowledge.js';
import { projects } from './schema-projects.js';

export const labelKinds = ['label', 'module'] as const;

export type LabelKind = (typeof labelKinds)[number];

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    kind: text('kind', { enum: labelKinds }).notNull().default('label'),
    parentId: uuid('parent_id').references((): AnyPgColumn => labels.id, { onDelete: 'set null' }),
    slug: text('slug'),
    knowledgeEntryId: uuid('knowledge_entry_id').references(() => knowledgeEntries.id, {
      onDelete: 'set null',
    }),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectNameUq: uniqueIndex('labels_project_id_name_uq').on(t.projectId, t.name),
    parentIdx: index('labels_parent_id_idx').on(t.parentId),
    projectSlugUq: uniqueIndex('labels_project_id_slug_uq').on(t.projectId, t.slug),
    knowledgeEntryUq: uniqueIndex('labels_knowledge_entry_id_uq').on(t.knowledgeEntryId),
    slugChk: check('labels_slug_chk', sql`(${t.kind} = 'module') = (${t.slug} IS NOT NULL)`),
    nodeChk: check(
      'labels_knowledge_entry_chk',
      sql`${t.kind} = 'module' OR ${t.knowledgeEntryId} IS NULL`,
    ),
    kindChk: check('labels_kind_chk', sql`${t.kind} IN ('label', 'module')`),
  }),
);

export const labelsRelations = relations(labels, ({ one, many }) => ({
  project: one(projects, { fields: [labels.projectId], references: [projects.id] }),
  parent: one(labels, {
    fields: [labels.parentId],
    references: [labels.id],
    relationName: 'labelHierarchy',
  }),
  children: many(labels, { relationName: 'labelHierarchy' }),
  issues: many(issueLabels),
}));
