// Where one issue's work stands inside its status (ISS-54): step, holder, branch, head, the status
// a park left. A status says only who it waits on; each move's history is `kernel_transitions`.

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';

/** A run's steps inside `in_progress` (and `release` inside `awaiting_release`), in order. */
export const workSteps = ['triage', 'clarify', 'plan', 'build', 'test', 'release'] as const;
export type WorkStep = (typeof workSteps)[number];

export interface WorkStepEntry {
  step: WorkStep;
  startedAt: string;
  endedAt: string | null;
}

/** How many past steps a row keeps; the oldest is dropped first. */
export const WORK_STEP_LOG_LIMIT = 50;

export const issueWorkState = pgTable(
  'issue_work_state',
  {
    issueId: uuid('issue_id')
      .primaryKey()
      .references(() => issues.id, { onDelete: 'cascade' }),
    step: text('step', { enum: workSteps }),
    stepStartedAt: timestamp('step_started_at', { withTimezone: true }),
    steps: jsonb('steps').$type<WorkStepEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** forge-plugin `flow/lease.mjs`'s lease, moved off `session_context`: JSON null is a null lease, SQL NULL none. */
    lease: jsonb('lease'),
    leaseHolder: text('lease_holder').generatedAlwaysAs(sql`nullif(lease ->> 'holder', '')`),
    branch: text('branch'),
    headSha: text('head_sha'),
    /** The status a park (`needs_info`, `on_hold`) left, and returns to; NULL off a park. */
    leftStatus: text('left_status'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stepPairChk: check(
      'issue_work_state_step_pair_chk',
      sql`(${t.step} IS NULL) = (${t.stepStartedAt} IS NULL)`,
    ),
    stepChk: check(
      'issue_work_state_step_chk',
      sql`${t.step} IS NULL OR ${t.step} IN ('triage', 'clarify', 'plan', 'build', 'test', 'release')`,
    ),
    stepsChk: check('issue_work_state_steps_chk', sql`jsonb_typeof(${t.steps}) = 'array'`),
    headShaChk: check(
      'issue_work_state_head_sha_chk',
      sql`${t.headSha} IS NULL OR ${t.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    branchChk: check(
      'issue_work_state_branch_chk',
      sql`${t.branch} IS NULL OR (${t.branch} ~ '[^[:space:]]' AND char_length(${t.branch}) <= 255)`,
    ),
    leftStatusChk: check(
      'issue_work_state_left_status_chk',
      sql`${t.leftStatus} IS NULL OR ${t.leftStatus} IN ('open', 'reopen', 'in_progress', 'approved', 'awaiting_release')`,
    ),
    leaseHolderIdx: index('issue_work_state_lease_holder_idx')
      .on(t.leaseHolder)
      .where(sql`lease_holder IS NOT NULL`),
  }),
);

export type IssueWorkStateRow = typeof issueWorkState.$inferSelect;
