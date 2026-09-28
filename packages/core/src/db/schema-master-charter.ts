import { sql } from 'drizzle-orm';
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
import { projects, users } from './schema.js';

/** The acts a master performs (dispatch/qa/release-flow phases, plus `park`), the closed set a
 *  knowledge condition's `verbs` may name (ISS-1313). */
export const masterVerbs = ['triage', 'dispatch', 'fold', 'judge', 'release', 'park'] as const;
export type MasterVerb = (typeof masterVerbs)[number];

/** A project's standing goal and rules, append-only by `version` so every declaration a project
 *  was ever given stays readable (ISS-1313). No row here means none declared. */
export const projectMasterCharters = pgTable(
  'project_master_charters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    goal: text('goal').notNull(),
    /** `string[]` — one rule per entry, held to that shape by a CHECK. */
    rules: jsonb('rules').notNull().default([]),
    declaredBy: uuid('declared_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectVersionUq: uniqueIndex('project_master_charters_project_version_uq').on(
      t.projectId,
      t.version,
    ),
    projectVersionIdx: index('project_master_charters_project_version_idx').on(
      t.projectId,
      t.version,
    ),
    goalNotBlankChk: check('master_charter_goal_not_blank_chk', sql`btrim(${t.goal}) <> ''`),
    rulesShapeChk: check(
      'master_charter_rules_shape_chk',
      sql`master_charter_rules_ok(${t.rules})`,
    ),
  }),
);
