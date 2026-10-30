import { CLEANUP_RESULTS, DEBT_KINDS, IMPACT_RATINGS, IMPACT_TYPES } from '@forge/contracts/cleanup';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
import { scheduleRuns } from './schema-schedule-runs.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The building agent's rating of its change (REQ-79 BC-4): the surface it touches, low, medium or
 * high, and why. Every rating is kept; an issue's newest is its current one.
 */
export const changeImpacts = pgTable(
  'change_impacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    type: text('type', { enum: IMPACT_TYPES }).notNull(),
    rating: text('rating', { enum: IMPACT_RATINGS }).notNull(),
    reason: text('reason').notNull(),
    commitSha: text('commit_sha'),
    ratedBy: uuid('rated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issueIdx: index('change_impacts_issue_idx').on(t.issueId, t.createdAt),
    typeChk: check('change_impacts_type_chk', sql`${t.type} IN (${inList(IMPACT_TYPES)})`),
    ratingChk: check(
      'change_impacts_rating_chk',
      sql`${t.rating} IN (${inList(IMPACT_RATINGS)})`,
    ),
  }),
);

/**
 * What a cleanup run reported (REQ-79 BC-9): the head it left, green or red, every debt it cleared
 * and every one that remains with why, and the issues rated high whose merge its green head carries.
 */
export const cleanupReports = pgTable(
  'cleanup_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The schedule fire that started the run; null for a run a person started. */
    scheduleRunId: uuid('schedule_run_id').references(() => scheduleRuns.id, {
      onDelete: 'set null',
    }),
    baseBranch: text('base_branch').notNull(),
    baseSha: text('base_sha').notNull(),
    result: text('result', { enum: CLEANUP_RESULTS }).notNull(),
    ci: text('ci'),
    /** `[{ debt, how }]`. */
    cleared: jsonb('cleared').notNull(),
    /** `[{ debt, why }]`. */
    remains: jsonb('remains').notNull(),
    /** The ids of the issues a green report covers, as a JSON array of strings. */
    covers: jsonb('covers').notNull(),
    reportedBy: uuid('reported_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index('cleanup_reports_project_idx').on(t.projectId, t.createdAt),
    resultChk: check(
      'cleanup_reports_result_chk',
      sql`${t.result} IN (${inList(CLEANUP_RESULTS)})`,
    ),
    coversChk: check(
      'cleanup_reports_covers_chk',
      sql`jsonb_typeof(${t.covers}) = 'array' AND (${t.result} = 'green' OR ${t.covers} = '[]'::jsonb)`,
    ),
  }),
);

/**
 * The cleanup ledger (REQ-79 BC-3, BC-7): debt an agent saw and left for the cleanup lane, rated as
 * a change is. Cleared once, by the cleanup report that names it cleared.
 */
export const deliveryDebts = pgTable(
  'delivery_debts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The issue being worked when it was seen; null for debt a cleanup run found itself. */
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: DEBT_KINDS }).notNull(),
    checkName: text('check_name'),
    location: text('location').notNull(),
    detail: text('detail').notNull(),
    impactType: text('impact_type', { enum: IMPACT_TYPES }).notNull(),
    impactRating: text('impact_rating', { enum: IMPACT_RATINGS }).notNull(),
    impactReason: text('impact_reason').notNull(),
    recordedBy: uuid('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clearedReportId: uuid('cleared_report_id').references(() => cleanupReports.id, {
      onDelete: 'set null',
    }),
    clearedHow: text('cleared_how'),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
  },
  (t) => ({
    openIdx: index('delivery_debts_open_idx')
      .on(t.projectId, t.createdAt)
      .where(sql`${t.clearedAt} IS NULL`),
    kindChk: check('delivery_debts_kind_chk', sql`${t.kind} IN (${inList(DEBT_KINDS)})`),
    typeChk: check(
      'delivery_debts_impact_type_chk',
      sql`${t.impactType} IN (${inList(IMPACT_TYPES)})`,
    ),
    ratingChk: check(
      'delivery_debts_impact_rating_chk',
      sql`${t.impactRating} IN (${inList(IMPACT_RATINGS)})`,
    ),
    redNamesCheckChk: check(
      'delivery_debts_red_check_chk',
      sql`${t.kind} <> 'red' OR ${t.checkName} IS NOT NULL`,
    ),
    redNotHighChk: check(
      'delivery_debts_red_not_high_chk',
      sql`${t.kind} <> 'red' OR ${t.impactRating} <> 'high'`,
    ),
    clearedChk: check(
      'delivery_debts_cleared_chk',
      sql`(${t.clearedAt} IS NULL) = (${t.clearedHow} IS NULL)`,
    ),
  }),
);
