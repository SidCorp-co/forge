import {
  INTAKE_DRAFT_CODES,
  INTAKE_DRAFT_OUTCOMES,
  VALUE_OUTCOMES,
} from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { feedback } from './schema-feedback.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** How a value check stands: one of its outcomes, or `held` while a blocking question stands. */
export const VALUE_CHECK_STATES = [...VALUE_OUTCOMES, 'held'] as const;
export type ValueCheckState = (typeof VALUE_CHECK_STATES)[number];

/**
 * The intake assistant's draft of one requirement or feedback item (REQ-34 BC-10..BC-16), owned by
 * the `intake` module and written only by its drafter: one row per item, the last draft standing.
 * `drafted` holds what it named, filled and asked in `body`, and what it was written as in
 * `applied`; `failed` holds the code it could not draft under, and `retry_owed` whether the outbox
 * delivers the item again for another try. `read` counts the records of each kind it read, which
 * are only requirements, workflows, feedback and releases.
 *
 * `value` is the item's one value check (REQ-65 BC-1, BC-2) and `value_outcome` how it ended, `held`
 * while a blocking question stands; both null on a draft made before the check, and on a failed one.
 * `kept_*` is the person who kept a refused requirement anyway, with their one-line reason (BC-6).
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
    retryOwed: boolean('retry_owed').notNull().default(false),
    read: jsonb('read').notNull(),
    body: jsonb('body'),
    applied: jsonb('applied'),
    value: jsonb('value'),
    valueOutcome: text('value_outcome', { enum: VALUE_CHECK_STATES }),
    keptReason: text('kept_reason'),
    keptBy: uuid('kept_by').references(() => users.id, { onDelete: 'set null' }),
    keptAt: timestamp('kept_at', { withTimezone: true }),
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
    retryChk: check('intake_drafts_retry_chk', sql`NOT ${t.retryOwed} OR ${t.outcome} = 'failed'`),
    valueOutcomeChk: check(
      'intake_drafts_value_outcome_chk',
      sql`${t.valueOutcome} IS NULL OR ${t.valueOutcome} IN (${inList(VALUE_CHECK_STATES)})`,
    ),
    valueChk: check(
      'intake_drafts_value_chk',
      sql`(${t.value} IS NULL) = (${t.valueOutcome} IS NULL) AND (${t.value} IS NULL OR ${t.outcome} = 'drafted')`,
    ),
    keptChk: check(
      'intake_drafts_kept_chk',
      sql`(${t.keptReason} IS NULL) = (${t.keptAt} IS NULL) AND (${t.keptReason} IS NULL OR ${t.keptReason} ~ '[^[:space:]]')`,
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

/**
 * A person's answer to one question of an item's intake draft (REQ-65 BC-3), by its number, with the
 * question and the option's label as asked, so it outlives the draft that asked it. `asked_at` is the
 * `drafted_at` of that draft: the answers of the draft standing are those asked at its own time.
 */
export const intakeAnswers = pgTable(
  'intake_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => intakeDrafts.id, { onDelete: 'cascade' }),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull(),
    question: integer('question').notNull(),
    prompt: text('prompt').notNull(),
    optionId: text('option_id').notNull(),
    label: text('label').notNull(),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    questionChk: check('intake_answers_question_chk', sql`${t.question} BETWEEN 1 AND 3`),
    questionUq: uniqueIndex('intake_answers_question_uq').on(t.draftId, t.askedAt, t.question),
  }),
);

export type IntakeAnswerRow = typeof intakeAnswers.$inferSelect;
