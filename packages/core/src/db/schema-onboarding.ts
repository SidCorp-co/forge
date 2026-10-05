import { QUESTIONNAIRE_MAX_ROUNDS, QUESTIONNAIRE_STATUSES } from '@forge/contracts/onboarding';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { conversationMessages, conversations } from './schema-conversations.js';
import { jobs } from './schema-jobs.js';
import { projects } from './schema-projects.js';
import { requirements } from './schema-requirements.js';
import { actorAgencies } from './schema-vocabulary.js';

export {
  QUESTIONNAIRE_STATUSES,
  type QuestionnaireStatus,
} from '@forge/contracts/onboarding';

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', '));

// cm:why onboarding is a conversation in the chat panel (owner, 2026-10-03): this row is the case
// the thread belongs to, one per project, so the thread, its rounds and its analysis job are read
// from one place and a second start is refused by name
export const onboardings = pgTable(
  'onboardings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    roundsSent: integer('rounds_sent').notNull().default(0),
    /** The workflow ids onboarding drafted: they take only a person's approval. */
    designs: jsonb('designs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastJobId: uuid('last_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    reanalyzedBy: uuid('reanalyzed_by').references(() => users.id, { onDelete: 'restrict' }),
    reanalyzedAt: timestamp('reanalyzed_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => users.id, { onDelete: 'restrict' }),
    doneAgency: text('done_agency', { enum: actorAgencies }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectUq: uniqueIndex('onboardings_project_uq').on(t.projectId),
    conversationUq: uniqueIndex('onboardings_conversation_uq').on(t.conversationId),
    roundsChk: check(
      'onboardings_rounds_chk',
      sql`${t.roundsSent} BETWEEN 0 AND ${sql.raw(String(QUESTIONNAIRE_MAX_ROUNDS))}`,
    ),
    doneChk: check('onboardings_done_chk', sql`(${t.doneAt} IS NULL) = (${t.doneBy} IS NULL)`),
    doneAgencyChk: check(
      'onboardings_done_agency_chk',
      sql`${t.doneAgency} IS NULL OR ${t.doneAgency} IN (${inList(actorAgencies)})`,
    ),
  }),
);

// cm:why a questionnaire is one structured message answered once: the batch is what the submit
// writes against and what a re-analysis supersedes; its items are agent_questions rows (one per
// decision) carrying batch_id
export const questionnaireBatches = pgTable(
  'questionnaire_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // cm:why an exclusive arc of real foreign keys: an onboarding round, a BA clarification on a
    // requirement, or a BA ask in an onboarding's first-requirements room
    onboardingId: uuid('onboarding_id').references(() => onboardings.id, { onDelete: 'cascade' }),
    requirementId: uuid('requirement_id').references(() => requirements.id, {
      onDelete: 'cascade',
    }),
    /** A BA ask in the first-requirements room this onboarding opened (project-onboarding `requirements`). */
    firstRequirementsOf: uuid('first_requirements_of').references(() => onboardings.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    intro: text('intro'),
    round: integer('round').notNull(),
    status: text('status', { enum: QUESTIONNAIRE_STATUSES }).notNull().default('open'),
    messageId: uuid('message_id').references(() => conversationMessages.id, {
      onDelete: 'set null',
    }),
    answersMessageId: uuid('answers_message_id').references(() => conversationMessages.id, {
      onDelete: 'set null',
    }),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    postedAgency: text('posted_agency', { enum: actorAgencies }).notNull(),
    submittedBy: uuid('submitted_by').references(() => users.id, { onDelete: 'restrict' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    skippedBy: uuid('skipped_by').references(() => users.id, { onDelete: 'restrict' }),
    skippedAt: timestamp('skipped_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededReason: text('superseded_reason'),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => questionnaireBatches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    arcChk: check(
      'questionnaire_batches_arc_chk',
      sql`num_nonnulls(${t.onboardingId}, ${t.requirementId}, ${t.firstRequirementsOf}) = 1`,
    ),
    statusChk: check(
      'questionnaire_batches_status_chk',
      sql`${t.status} IN (${inList(QUESTIONNAIRE_STATUSES)})`,
    ),
    roundChk: check(
      'questionnaire_batches_round_chk',
      sql`${t.round} BETWEEN 1 AND ${sql.raw(String(QUESTIONNAIRE_MAX_ROUNDS))}`,
    ),
    postedAgencyChk: check(
      'questionnaire_batches_posted_agency_chk',
      sql`${t.postedAgency} IN (${inList(actorAgencies)})`,
    ),
    submittedChk: check(
      'questionnaire_batches_submitted_chk',
      sql`(${t.status} = 'submitted') = (${t.submittedAt} IS NOT NULL AND ${t.submittedBy} IS NOT NULL)`,
    ),
    supersededChk: check(
      'questionnaire_batches_superseded_chk',
      sql`(${t.status} = 'superseded') = (${t.supersededAt} IS NOT NULL)`,
    ),
    // cm:guard one open batch per thread (QUESTIONNAIRE_ALREADY_OPEN): a skipped batch still waits
    // on its person, so nothing more is asked over it
    openPerConversationUq: uniqueIndex('questionnaire_batches_open_conversation_uq')
      .on(t.conversationId)
      .where(sql`status IN ('open', 'skipped')`),
    // cm:guard the BA assistant holds at most one open ask per requirement (Q5): a batch is that ask
    openPerRequirementUq: uniqueIndex('questionnaire_batches_open_requirement_uq')
      .on(t.requirementId)
      .where(sql`status IN ('open', 'skipped') AND requirement_id IS NOT NULL`),
    projectIdx: index('questionnaire_batches_project_idx').on(t.projectId, t.status),
    onboardingIdx: index('questionnaire_batches_onboarding_idx').on(t.onboardingId),
    firstRequirementsIdx: index('questionnaire_batches_first_requirements_idx')
      .on(t.firstRequirementsOf)
      .where(sql`${t.firstRequirementsOf} IS NOT NULL`),
  }),
);
