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
import { users } from './schema-auth.js';
import { organizations } from './schema-orgs.js';
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
  // one lesson's text, or one month's lesson figures (REQ-50 BC-3, BC-8); written only by the
  // lessons module (`lesson-entries.ts`)
  'lesson',
] as const;

/** What a knowledge or memory entry is (REQ-89 BC-4): a verified fact, a hypothesis, or a convention the owner settled. */
export const knowledgeEntryTypes = ['fact', 'hypothesis', 'convention'] as const;

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
    /**
     * What the entry rests on (`file.ts:symbol` anchors, an issue or requirement key, a URL), where
     * it applies, and the change that means it needs re-checking (ISS-1064). Null on a row written
     * before they were asked for, which the anchor audit lists as owing them: the write path
     * (`knowledge/provenance.ts`) refuses an entry of a kind that owes them, never a NOT NULL here.
     */
    source: text('source'),
    scope: text('scope'),
    recheckWhen: text('recheck_when'),
    /** Whether the entry is a verified fact, a hypothesis or a convention (ISS-1121); null on a row owing it. */
    entryType: text('entry_type', { enum: knowledgeEntryTypes }),
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
    /**
     * The module it belongs to (ISS-1256): a module label of the same project, written only by the
     * placement door an agent calls (`labels/module-map-place.ts`); null where nobody placed it.
     */
    moduleId: uuid('module_id'),
    /**
     * A term's other names and who named it (ISS-1256, `@forge/contracts/module-map` TermFields):
     * `{ aliases?: { vi?, code?, industry? }, namedBy?: { who, quote } }`; only a `glossary` entry.
     */
    term: jsonb('term'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    moduleIdx: index('knowledge_entries_module_idx').on(t.projectId, t.moduleId),
    termChk: check(
      'knowledge_entries_term_chk',
      sql`${t.term} IS NULL OR (${t.kind} = 'glossary' AND jsonb_typeof(${t.term}) = 'object')`,
    ),
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
    entryTypeChk: check(
      'knowledge_entries_entry_type_chk',
      sql`${t.entryType} IS NULL OR ${t.entryType} IN ('fact', 'hypothesis', 'convention')`,
    ),
  }),
);

/**
 * The module map's stored relations (ISS-1256): each starts at a term or a rule and is one of four
 * kinds, `used_in` (term → rule or capability), `governs` (rule → capability), `from` (term or rule →
 * requirement or decision) and `anchored_at` (term or rule → `file.ts:symbol`). `belongs_to` is the
 * entry's `module_id`, never a row. Written only by an agent's or a person's call; an anchor is weighed
 * by the landing re-check like the entry's own `source` (`knowledge/recheck.ts`).
 */
export const knowledgeRelations = pgTable(
  'knowledge_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromEntryId: uuid('from_entry_id')
      .notNull()
      .references(() => knowledgeEntries.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['used_in', 'governs', 'from', 'anchored_at'] }).notNull(),
    toType: text('to_type', {
      enum: ['term', 'rule', 'capability', 'requirement', 'decision', 'code'],
    }).notNull(),
    toRef: text('to_ref').notNull(),
    writtenBy: uuid('written_by').references(() => users.id, { onDelete: 'set null' }),
    writtenAgency: text('written_agency', { enum: ['human', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindChk: check(
      'knowledge_relations_kind_chk',
      sql`${t.kind} IN ('used_in', 'governs', 'from', 'anchored_at')`,
    ),
    toTypeChk: check(
      'knowledge_relations_to_type_chk',
      sql`${t.toType} IN ('term', 'rule', 'capability', 'requirement', 'decision', 'code')`,
    ),
    agencyChk: check(
      'knowledge_relations_agency_chk',
      sql`${t.writtenAgency} IN ('human', 'agent')`,
    ),
    toRefChk: check(
      'knowledge_relations_to_ref_chk',
      sql`length(${t.toRef}) BETWEEN 1 AND 512`,
    ),
    edgeUq: uniqueIndex('knowledge_relations_edge_uq').on(
      t.fromEntryId,
      t.kind,
      t.toType,
      t.toRef,
    ),
    projectIdx: index('knowledge_relations_project_idx').on(t.projectId, t.toType, t.toRef),
  }),
);

/**
 * The text a rewrite of a knowledge entry replaced (ISS-1121, REQ-89 BC-2): kept by the
 * `knowledge_entries_record_replacement` trigger (migration 0630) whenever a title or body changes,
 * so a write on a subject already held updates that entry and its old text stays readable.
 */
export const knowledgeEntryRevisions = pgTable(
  'knowledge_entry_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => knowledgeEntries.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entryType: text('entry_type'),
    scope: text('scope'),
    recheckWhen: text('recheck_when'),
    replacedAt: timestamp('replaced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryReplacedIdx: index('knowledge_entry_revisions_entry_replaced_idx').on(
      t.entryId,
      t.replacedAt,
    ),
  }),
);

export const knowledgeEntriesRelations = relations(knowledgeEntries, ({ one }) => ({
  project: one(projects, { fields: [knowledgeEntries.projectId], references: [projects.id] }),
}));

/**
 * An organisation's own knowledge (ISS-861): one entry per slug, carried into every project of the
 * org ahead of the project's own always-on entries, a project entry under the same slug taking its
 * place. A sibling of `knowledge_entries` rather than a nullable `project_id` there: every read of
 * the project store filters by project, and an org row kept out of all of them by a null is a leak
 * waiting for the one query that forgets it.
 */
export const orgKnowledgeEntries = pgTable(
  'org_knowledge_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    injection: text('injection', { enum: ['always', 'on_demand'] })
      .notNull()
      .default('always'),
    orderIndex: integer('order_index').notNull().default(0),
    /** As on `knowledge_entries` (ISS-1064): every org entry owes them, refused at the write path. */
    source: text('source'),
    scope: text('scope'),
    recheckWhen: text('recheck_when'),
    /** The re-check a landing or a rule change flagged on this entry; a rewrite clears it (ISS-1121). */
    recheckDue: jsonb('recheck_due'),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgSlugUq: uniqueIndex('org_knowledge_entries_org_slug_uq').on(t.orgId, t.slug),
    injectionChk: check(
      'org_knowledge_entries_injection_chk',
      sql`${t.injection} IN ('always', 'on_demand')`,
    ),
  }),
);
