/**
 * What a whole-backlog question reads instead of computing (ISS-1336): a score per takeable issue,
 * the nearest issues per unsettled issue, and the queue of changes that have not reached either.
 *
 * The queue is written by Postgres triggers (migration 0327), never by application code, so a
 * writer that emits no event still marks it. `docs/modules/issues/backlog-index.md` is the contract.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, projects } from './schema.js';
import { MEMORY_EMBEDDING_DIM, pgVector } from './schema-types.js';

export const backlogIndexKinds = ['rank', 'alike-seed', 'alike-target'] as const;
export type BacklogIndexKind = (typeof backlogIndexKinds)[number];

/** The subject of a mark that names the whole project: every issue is to be read again. */
export const WHOLE_PROJECT_SUBJECT = '00000000-0000-0000-0000-000000000000';

export const backlogIndexDirty = pgTable(
  'backlog_index_dirty',
  {
    indexKind: text('index_kind', { enum: backlogIndexKinds }).notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').notNull(),
    reason: text('reason').notNull(),
    /** A repeated mark bumps it; a drain deletes only the generation it read, so a change that arrives mid-drain survives. */
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    firstMarkedAt: timestamp('first_marked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.indexKind, t.projectId, t.subjectId] }),
    projectKindIdx: index('backlog_index_dirty_project_kind_idx').on(
      t.projectId,
      t.indexKind,
      t.firstMarkedAt,
    ),
    kindChk: check(
      'backlog_index_dirty_kind_chk',
      sql`${t.indexKind} IN ('rank', 'alike-seed', 'alike-target')`,
    ),
  }),
);

/** One row per takeable issue: every term of its score but age, which the clock moves and a read adds. */
export const issueRankScores = pgTable(
  'issue_rank_scores',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    staticScore: doublePrecision('static_score').notNull(),
    parts: jsonb('parts').$type<Array<{ name: string; said: string; points: number }>>().notNull(),
    chainCount: integer('chain_count').notNull(),
    /** Hash of the weights the row was scored under; a row under other weights is not covered. */
    weightsHash: text('weights_hash').notNull(),
    /** The first moment an edge this score walked lapses, after which the chained term is stale. */
    freshUntil: timestamp('fresh_until', { withTimezone: true }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('issue_rank_scores_project_idx').on(t.projectId),
    lapseIdx: index('issue_rank_scores_lapse_idx')
      .on(t.projectId, t.freshUntil)
      .where(sql`fresh_until IS NOT NULL`),
  }),
);

/** One row per unsettled issue: the vector of its title and what the memory search found for it. */
export const issueAlikeSeeds = pgTable(
  'issue_alike_seeds',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The title as embedded; a seed whose issue now reads another title is not measured. */
    title: text('title').notNull(),
    titleEmbedding: pgVector(MEMORY_EMBEDDING_DIM)('title_embedding').notNull(),
    /** The memory model and embeddings model the measurement ran under. */
    measuredWith: text('measured_with').notNull(),
    /** The lowest score kept, or NULL where fewer than the full set were found and nothing is excluded. */
    floorScore: real('floor_score'),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('issue_alike_seeds_project_idx').on(t.projectId),
  }),
);

export const issueAlikeHits = pgTable(
  'issue_alike_hits',
  {
    seedIssueId: uuid('seed_issue_id')
      .notNull()
      .references(() => issueAlikeSeeds.issueId, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    memoryId: uuid('memory_id').notNull(),
    /** The issue the memory row is about; NULL where its source reference is not an issue id. */
    hitIssueId: uuid('hit_issue_id'),
    score: real('score').notNull(),
    stale: boolean('stale').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.seedIssueId, t.position] }),
    hitIdx: index('issue_alike_hits_hit_issue_idx').on(t.hitIssueId),
  }),
);
