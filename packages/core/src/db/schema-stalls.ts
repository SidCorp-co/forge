import { STALL_CAUSES, STALL_ENDINGS } from '@forge/contracts/stalls';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
import { agentQuestions } from './schema-questions.js';
import { requirements } from './schema-requirements.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One delivery stall (REQ-67 BC-6): its cause, the requirement or feedback item that caused it, the
 * issue it stalled and the question it raised. Written by `issues/stalls.ts:startStall` in the
 * transaction of the act that starts it and ended by `endStalls` in the act that clears it. A stall
 * nobody cleared keeps `ended_at` null and stays counted as open. Its release is read through the
 * release's roster at read time, never stored (`release-page/stalls.ts`).
 */
export const stalls = pgTable(
  'stalls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    cause: text('cause').notNull(),
    requirementId: uuid('requirement_id').references(() => requirements.id, {
      onDelete: 'cascade',
    }),
    feedbackId: uuid('feedback_id').references(() => feedback.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    /** The question it raised; its words are kept in `question` should the question row go. */
    questionId: uuid('question_id').references(() => agentQuestions.id, { onDelete: 'set null' }),
    question: text('question'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
  },
  (t) => ({
    issueIdx: index('stalls_issue_idx').on(t.issueId),
    requirementIdx: index('stalls_requirement_idx').on(t.requirementId),
    feedbackIdx: index('stalls_feedback_idx').on(t.feedbackId),
    questionIdx: index('stalls_question_idx').on(t.questionId),
    causeChk: check('stalls_cause_chk', sql`${t.cause} IN (${inList(STALL_CAUSES)})`),
    endedByChk: check(
      'stalls_ended_by_chk',
      sql`(${t.endedAt} IS NULL) = (${t.endedBy} IS NULL) AND (${t.endedBy} IS NULL OR ${t.endedBy} IN (${inList(STALL_ENDINGS)}))`,
    ),
    placedChk: check(
      'stalls_placed_chk',
      sql`CASE ${t.cause} WHEN 'unclear_item' THEN ${t.requirementId} IS NOT NULL OR ${t.feedbackId} IS NOT NULL ELSE ${t.issueId} IS NOT NULL END`,
    ),
  }),
);
