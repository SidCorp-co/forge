import { PAT_FENCE_REASON_MAX } from '@forge/contracts/pat-fence';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { personalAccessTokens, users } from './schema.js';

// cm:why a fence edit changes what a live secret reaches, so each edit is a row of its own naming who
// made it, why, and the fence on both sides (ISS-92); insert-only by pat_fence_change_guard(), and a
// row goes only with its token
export const patFenceChanges = pgTable(
  'pat_fence_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => personalAccessTokens.id, { onDelete: 'cascade' }),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    previousProjectIds: uuid('previous_project_ids').array(),
    previousBoundProjectId: uuid('previous_bound_project_id'),
    projectIds: uuid('project_ids').array(),
    boundProjectId: uuid('bound_project_id'),
    reason: text('reason').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenChangedIdx: index('pat_fence_changes_token_changed_idx').on(t.tokenId, t.changedAt),
    reasonChk: check(
      'pat_fence_changes_reason_chk',
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND ${sql.raw(String(PAT_FENCE_REASON_MAX))}`,
    ),
    oneFenceChk: check(
      'pat_fence_changes_one_fence_chk',
      sql`(${t.boundProjectId} IS NULL) <> (${t.projectIds} IS NULL OR cardinality(${t.projectIds}) = 0)`,
    ),
  }),
);

export type PatFenceChangeRow = typeof patFenceChanges.$inferSelect;
