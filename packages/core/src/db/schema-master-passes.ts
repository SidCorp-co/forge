import { MASTER_VERBS, type MasterPassSkip } from '@forge/contracts/master-standing';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentSessions, projects } from './schema.js';

// cm:why a pass is evidence the board reads (design agent-run-standing decision: passes are stored, one row
// per pass), so the box is never its only witness; a closed row is final, enforced by master_pass_guard()
export const masterPasses = pgTable(
  'master_passes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    masterSessionId: uuid('master_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    verb: text('verb', { enum: MASTER_VERBS }).notNull(),
    issueKey: text('issue_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    dispatched: text('dispatched').array().notNull().default(sql`ARRAY[]::text[]`),
    skipped: jsonb('skipped').$type<MasterPassSkip[]>().notNull().default(sql`'[]'::jsonb`),
    parked: text('parked').array().notNull().default(sql`ARRAY[]::text[]`),
  },
  (t) => ({
    oneOpenPerSessionUq: uniqueIndex('master_passes_one_open_uq')
      .on(t.masterSessionId)
      .where(sql`ended_at IS NULL`),
    projectStartedIdx: index('master_passes_project_started_idx').on(t.projectId, t.startedAt),
    projectEndedIdx: index('master_passes_project_ended_idx').on(t.projectId, t.endedAt),
    verbChk: check(
      'master_passes_verb_chk',
      sql`${t.verb} IN (${sql.raw(MASTER_VERBS.map((v) => `'${v}'`).join(', '))})`,
    ),
    endedAfterStartChk: check(
      'master_passes_ended_after_start_chk',
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
    skippedShapeChk: check('master_passes_skipped_shape_chk', sql`jsonb_typeof(${t.skipped}) = 'array'`),
    openPassReportsNothingChk: check(
      'master_passes_open_reports_nothing_chk',
      sql`${t.endedAt} IS NOT NULL OR (cardinality(${t.dispatched}) = 0 AND cardinality(${t.parked}) = 0 AND ${t.skipped} = '[]'::jsonb)`,
    ),
  }),
);

export type MasterPassRow = typeof masterPasses.$inferSelect;
