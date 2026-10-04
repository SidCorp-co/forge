/**
 * `issue_work_state` — where one issue's work stands inside its status (ISS-54). This module is the
 * only writer of the table. The status says who an issue waits on; this row says the run's step,
 * who holds it, the branch and head it built, and the status a park left.
 *
 * cm:edge contract -> packages/core/src/db/schema-issue-work-state.ts — the columns and their checks.
 */

import { eq, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import {
  type IssueWorkStateRow,
  issueWorkState,
  WORK_STEP_LOG_LIMIT,
  type WorkStep,
  type WorkStepEntry,
  workSteps,
} from '../db/schema-issue-work-state.js';
import { issueWorkInFlightSql } from './issue-lease.js';
import { classifyLease } from './session-claim.js';

export { type WorkStep, workSteps };

type Executor = Pick<Tx, 'select' | 'insert' | 'update' | 'execute'>;

export async function readWorkState(
  executor: Pick<Tx, 'select'>,
  issueId: string,
): Promise<IssueWorkStateRow | null> {
  const [row] = await executor
    .select()
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .limit(1);
  return row ?? null;
}

/** The step log with the open entry closed at `at` and `next` opened, newest last, capped. */
export function nextStepLog(
  log: readonly WorkStepEntry[],
  next: WorkStep | null,
  at: Date,
): WorkStepEntry[] {
  const iso = at.toISOString();
  const closed = log.map((entry, i) =>
    i === log.length - 1 && entry.endedAt === null ? { ...entry, endedAt: iso } : entry,
  );
  const opened =
    next === null ? closed : [...closed, { step: next, startedAt: iso, endedAt: null }];
  return opened.slice(-WORK_STEP_LOG_LIMIT);
}

/**
 * Move the run's step. Re-entering the step it is at changes nothing, so its start time is the
 * first entry's; `null` ends the step without opening another (a checkpoint, a release, an exit).
 */
export async function setWorkStep(
  executor: Executor,
  issueId: string,
  step: WorkStep | null,
  now: Date = new Date(),
): Promise<void> {
  const held = await readWorkStateForUpdate(executor, issueId);
  if ((held?.step ?? null) === step) return;
  const steps = nextStepLog(held?.steps ?? [], step, now);
  const values = { step, stepStartedAt: step === null ? null : now, steps, updatedAt: now };
  await executor
    .insert(issueWorkState)
    .values({ issueId, ...values })
    .onConflictDoUpdate({ target: issueWorkState.issueId, set: values });
}

async function readWorkStateForUpdate(
  executor: Executor,
  issueId: string,
): Promise<IssueWorkStateRow | null> {
  const [row] = await executor
    .select()
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .for('update')
    .limit(1);
  return row ?? null;
}

/** Record (or clear) the status a park left. */
export async function setLeftStatus(
  executor: Executor,
  issueId: string,
  leftStatus: IssueStatus | null,
): Promise<void> {
  const values = { leftStatus, updatedAt: new Date() };
  await executor
    .insert(issueWorkState)
    .values({ issueId, ...values })
    .onConflictDoUpdate({ target: issueWorkState.issueId, set: values });
}

/** A write of the branch or head a run built, from a client on the 10-status model. */
export interface WorkStateWrite {
  step?: WorkStep | null | undefined;
  branch?: string | null | undefined;
  headSha?: string | null | undefined;
}

export async function writeWorkStateFields(
  executor: Executor,
  issueId: string,
  write: WorkStateWrite,
): Promise<void> {
  if (write.step !== undefined) await setWorkStep(executor, issueId, write.step);
  const set: Partial<typeof issueWorkState.$inferInsert> = {};
  if (write.branch !== undefined) set.branch = write.branch;
  if (write.headSha !== undefined) set.headSha = write.headSha?.toLowerCase() ?? null;
  if (Object.keys(set).length === 0) return;
  const values = { ...set, updatedAt: new Date() };
  await executor
    .insert(issueWorkState)
    .values({ issueId, ...values })
    .onConflictDoUpdate({ target: issueWorkState.issueId, set: values });
}

const FULL_SHA = /^[0-9a-f]{40}$/iu;

function nonBlankString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * cm:hack a whole `sessionContext` as forge-plugin 3.36.542 writes it, cut into what stays in the
 * blob and what this table owns: the `lease` key leaves the blob (`present` says the key was
 * written at all, a JSON null included), and the branch and head its worklog names are read into
 * the typed columns the kernel reads. Exit: until forge-plugin moves to the 10-status model
 * (plugin-followups.md) and writes `workState` itself.
 */
export interface SplitSessionContext {
  rest: Record<string, unknown> | null;
  lease: { present: boolean; value: unknown };
  branch: string | null;
  headSha: string | null;
}

export function splitSessionContext(value: unknown): SplitSessionContext {
  const blob = objectOf(value);
  if (!blob)
    return { rest: null, lease: { present: false, value: null }, branch: null, headSha: null };
  const { lease, ...rest } = blob;
  const worklog = objectOf(blob.worklog);
  const head = typeof worklog?.head === 'string' ? worklog.head.trim() : '';
  return {
    rest,
    lease: { present: 'lease' in blob, value: lease ?? null },
    branch: nonBlankString(blob.branch, 255) ?? nonBlankString(worklog?.branch, 255),
    headSha: FULL_SHA.test(head) ? head.toLowerCase() : null,
  };
}

/** The work-state half of a split `sessionContext` write, in the write's own transaction. */
export async function writeSplitSessionContext(
  executor: Executor,
  issueId: string,
  split: SplitSessionContext,
): Promise<void> {
  const lease = split.lease.present
    ? sql`${JSON.stringify(split.lease.value)}::jsonb`
    : sql`NULL::jsonb`;
  await executor.execute(sql`
    INSERT INTO issue_work_state (issue_id, lease, branch, head_sha, updated_at)
    VALUES (${issueId}, ${lease}, ${split.branch}, ${split.headSha}, now())
    ON CONFLICT (issue_id) DO UPDATE
      SET lease = EXCLUDED.lease, branch = EXCLUDED.branch, head_sha = EXCLUDED.head_sha,
          updated_at = now()
  `);
}

/** The shape every reply carries next to `status`. */
export interface WorkStateView {
  step: WorkStep | null;
  stepStartedAt: string | null;
  steps: WorkStepEntry[];
  leaseHolder: string | null;
  branch: string | null;
  headSha: string | null;
  leftStatus: IssueStatus | null;
}

/** The list rows' `WorkStateView`: the step log is a detail read, never a page of 200 rows'. */
export type WorkStateListView = Omit<WorkStateView, 'steps'>;

function workStateObjectSql(withSteps: boolean): SQL {
  const steps = withSteps ? sql`'steps', w.steps,` : sql``;
  return sql`(
  SELECT jsonb_build_object(
           'step', w.step,
           'stepStartedAt', w.step_started_at,
           ${steps}
           'leaseHolder', w.lease_holder,
           'branch', w.branch,
           'headSha', w.head_sha,
           'leftStatus', w.left_status)
    FROM issue_work_state w WHERE w.issue_id = "issues"."id")`;
}

/** `WorkStateView` of the issue row in scope as `issues`, or SQL NULL where it has no work state. */
export const workStateViewSql = sql<WorkStateView | null>`${workStateObjectSql(true)}`;
export const workStateListSql = sql<WorkStateListView | null>`${workStateObjectSql(false)}`;

/** cm:hack the `sessionContext` a reply carries: the row's blob with its lease put back. */
export function composedSessionContextSql(issueId: SQL | string, context: SQL): SQL {
  return sql`issue_session_context(${issueId}, ${context})`;
}

/**
 * Who holds the issue: a live lease on its work state, or a job, run or fleet lease over it. A lease
 * whose holder stopped beating is abandoned, not held — the wedge net's reading (`classifyLease`).
 */
export async function issueHolder(
  executor: Pick<Tx, 'select' | 'execute'>,
  issue: { id: string; projectId: string },
  now: Date = new Date(),
  exceptRunId: string | null = null,
): Promise<string | null> {
  const held = await readWorkState(executor, issue.id);
  const lease = classifyLease({ lease: held?.lease ?? null, now, fanout: 1 });
  if (lease.verdict === 'live' || lease.verdict === 'shared') return `lease ${lease.holder}`;
  const rows = (await executor.execute(sql`
    SELECT ${issueWorkInFlightSql({
      issueId: sql`i.id`,
      projectId: sql`i.project_id`,
      issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
      exceptRunId,
    })} AS held
      FROM issues i WHERE i.id = ${issue.id}
  `)) as unknown as Array<{ held: boolean }>;
  return rows[0]?.held ? 'a job, run or fleet lease' : null;
}
