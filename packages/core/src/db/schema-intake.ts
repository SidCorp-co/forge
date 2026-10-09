import { INTAKE_DRAFT_CODES, INTAKE_DRAFT_OUTCOMES } from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { feedback } from './schema-feedback.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The intake assistant's draft of one requirement or feedback item (REQ-34 BC-10..BC-16), owned by
 * the `intake` module and written only by its drafter: one row per item, the last draft standing.
 * `drafted` holds what it named, filled and asked in `body`, and what it was written as in
 * `applied`; `failed` holds the code it could not draft under. `read` counts the records of each
 * kind it read, which are only requirements, workflows, feedback and releases.
 */
export const intakeDrafts = pgTable(
  'intake_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // an exclusive arc of real foreign keys
    requirementId: uuid('requirement_id').references((): AnyPgColumn => requirements.id, {
      onDelete: 'cascade',
    }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => feedback.id, {
      onDelete: 'cascade',
    }),
    outcome: text('outcome', { enum: INTAKE_DRAFT_OUTCOMES }).notNull(),
    code: text('code', { enum: INTAKE_DRAFT_CODES }),
    detail: text('detail'),
    model: text('model'),
    attempts: integer('attempts').notNull().default(1),
    read: jsonb('read').notNull(),
    body: jsonb('body'),
    applied: jsonb('applied'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    arcChk: check(
      'intake_drafts_arc_chk',
      sql`num_nonnulls(${t.requirementId}, ${t.feedbackId}) = 1`,
    ),
    outcomeChk: check(
      'intake_drafts_outcome_chk',
      sql`${t.outcome} IN (${inList(INTAKE_DRAFT_OUTCOMES)})`,
    ),
    codeChk: check(
      'intake_drafts_code_chk',
      sql`${t.code} IS NULL OR ${t.code} IN (${inList(INTAKE_DRAFT_CODES)})`,
    ),
    shapeChk: check(
      'intake_drafts_shape_chk',
      sql`(${t.outcome} = 'drafted' AND ${t.code} IS NULL AND jsonb_typeof(${t.body}) = 'object') OR (${t.outcome} = 'failed' AND ${t.code} IS NOT NULL AND ${t.body} IS NULL)`,
    ),
    requirementUq: uniqueIndex('intake_drafts_requirement_uq')
      .on(t.requirementId)
      .where(sql`requirement_id IS NOT NULL`),
    feedbackUq: uniqueIndex('intake_drafts_feedback_uq')
      .on(t.feedbackId)
      .where(sql`feedback_id IS NOT NULL`),
  }),
);

export type IntakeDraftRow = typeof intakeDrafts.$inferSelect;
