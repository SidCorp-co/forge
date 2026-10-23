import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';

export const RELEASE_NAMING_DRAFT_STATES = ['drafting', 'failed'] as const;

/**
 * The assistant's draft of a release's name and summary while it is owed or refused (REQ-40 BC-14),
 * one row per project and version, owned by the `release-page` domain and written only by its namer:
 * `drafting` while a draft is in flight, `failed` with every reason the last one was refused for.
 * The row goes once the release is named; the name itself lives in `release_draft_namings`, then on
 * the run that cut it.
 */
export const releaseNamingDrafts = pgTable(
  'release_naming_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    state: text('state', { enum: RELEASE_NAMING_DRAFT_STATES }).notNull(),
    model: text('model'),
    refusals: jsonb('refusals').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex('release_naming_drafts_project_version_uq').on(t.projectId, t.version),
    stateChk: check('release_naming_drafts_state_chk', sql`${t.state} IN ('drafting', 'failed')`),
    refusalsChk: check(
      'release_naming_drafts_refusals_chk',
      sql`jsonb_typeof(${t.refusals}) = 'array'`,
    ),
    failedChk: check(
      'release_naming_drafts_failed_chk',
      sql`${t.state} <> 'failed' OR jsonb_array_length(${t.refusals}) > 0`,
    ),
  }),
);

export type ReleaseNamingDraftRow = typeof releaseNamingDrafts.$inferSelect;
