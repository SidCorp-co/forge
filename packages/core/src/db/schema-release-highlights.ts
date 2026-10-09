import { RELEASE_HIGHLIGHTS_STATES } from '@forge/contracts/release-page';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The highlights a release page opens on (REQ-40 BC-2), one row per release run, owned by the
 * `release-page` domain and written only by its drafter: `pending` while a draft is owed, `drafted`
 * with the highlights the judge let through and the digest of the facts they were drafted from,
 * `failed` with the refusals the last draft earned. Nobody edits one by hand.
 */
export const releaseHighlights = pgTable(
  'release_highlights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    state: text('state', { enum: RELEASE_HIGHLIGHTS_STATES }).notNull(),
    highlights: jsonb('highlights'),
    model: text('model'),
    /** The digest of the facts the stored state answers; null where the next refresh drafts regardless. */
    sourceDigest: text('source_digest'),
    draftedAt: timestamp('drafted_at', { withTimezone: true }),
    refusals: jsonb('refusals').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runUq: uniqueIndex('release_highlights_run_uq').on(t.runId),
    projectIdx: index('release_highlights_project_idx').on(t.projectId, t.version),
    stateChk: check(
      'release_highlights_state_chk',
      sql`${t.state} IN (${inList(RELEASE_HIGHLIGHTS_STATES)})`,
    ),
    draftedChk: check(
      'release_highlights_drafted_chk',
      sql`${t.state} <> 'drafted' OR (jsonb_typeof(${t.highlights}) = 'array' AND ${t.model} IS NOT NULL AND ${t.sourceDigest} IS NOT NULL AND ${t.draftedAt} IS NOT NULL)`,
    ),
    refusalsChk: check(
      'release_highlights_refusals_chk',
      sql`jsonb_typeof(${t.refusals}) = 'array'`,
    ),
  }),
);

export type ReleaseHighlightsRow = typeof releaseHighlights.$inferSelect;
