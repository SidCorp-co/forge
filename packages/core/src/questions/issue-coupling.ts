// An agent question and the issue it stops are one state: the reads and writes that keep them in step.
//
// Both halves run inside the issue transition's own transaction, so there is one
// writer to `issues.status` and it is `issues/apply-transition.ts`. Nothing here
// moves an issue; it refuses or voids alongside the move that does (ISS-1257).

import { and, eq, inArray, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { IssueStatus } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { ISSUE_STATUS_LABELS, ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';

type Executor = IssueDependencyExecutor;

export const QUESTION_ENDED_WITH_ISSUE = 'issue_terminal';
export const QUESTION_NOT_NEEDED = 'not_needed';

/**
 * The marker that a person owes an issue an answer: an open `human` question on it.
 * Read from the rows, never stored, so answering or voiding the last one clears it.
 */
export function holdsOpenHumanQuestion(issueId: SQLWrapper): SQL {
  return sql`exists (select 1 from agent_questions q
    where q.issue_id = ${issueId} and q.status = 'open' and q.blocker_kind = 'human')`;
}

/** Whether a person owes the issue an answer. A transition calls it after locking the row, so an ask in flight commits first. */
export async function personOwesAnAnswer(executor: Executor, issueId: string): Promise<boolean> {
  const rows = await executor.execute(
    sql`select ${holdsOpenHumanQuestion(sql`${issueId}::uuid`)} as held`,
  );
  return (rows[0] as { held?: boolean } | undefined)?.held === true;
}

export async function openQuestionIdsOn(executor: Executor, issueId: string): Promise<string[]> {
  const rows = await executor
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.issueId, issueId), eq(agentQuestions.status, 'open')))
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  return rows.map((r) => r.id);
}

/** The open questions a person owes an answer to — the rows the marker above is read from. */
export async function openHumanQuestionIdsOn(
  executor: Executor,
  issueId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.issueId, issueId),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
      ),
    )
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  return rows.map((r) => r.id);
}

export type TerminalQuestionFault = {
  code: 'OPEN_QUESTIONS' | 'VOID_REASON_REQUIRED';
  detail: string;
  details: Record<string, unknown>;
};

/** The refusal a terminal move meets while these questions are open; a release reads it before its press. */
export function openQuestionsFault(
  ids: readonly string[],
  toStatus: IssueStatus,
): TerminalQuestionFault {
  const noun = ids.length === 1 ? 'open question' : 'open questions';
  return {
    code: 'OPEN_QUESTIONS',
    detail: `this issue holds ${ids.length} ${noun} (${ids.join(', ')}), and \`${toStatus}\` would leave ${ids.length === 1 ? 'it' : 'them'} asking a person for a decision nothing can act on. Answer ${ids.length === 1 ? 'it' : 'them'} first, or send this move again with \`voidQuestions: "<why they died with the work>"\`, which voids each one with that reason in the same write.`,
    details: { to: toStatus, openQuestionIds: [...ids] },
  };
}

/**
 * Refuse a terminal move while the issue holds an open question, or void those
 * questions with the reason the caller gave — on any move that sends one; and,
 * with `requireNoOpenQuestions`, refuse any move while one is open (the answer resume).
 *
 * The issue row is locked first, so an ask racing this move either
 * committed before it — and is seen here — or waits and then finds the move made.
 */
export async function settleOpenQuestions(
  tx: Executor,
  args: {
    issueId: string;
    toStatus: IssueStatus;
    voidQuestions?: string | undefined;
    requireNoOpenQuestions?: boolean | undefined;
    by: string;
  },
): Promise<TerminalQuestionFault | null> {
  const terminal = ISSUE_TERMINAL_STATUSES.includes(args.toStatus);
  const settles =
    terminal || args.requireNoOpenQuestions === true || args.voidQuestions !== undefined;
  if (settles) await tx.execute(sql`select 1 from issues where id = ${args.issueId} for update`);
  if (!terminal && args.voidQuestions === undefined) {
    if (!args.requireNoOpenQuestions) return null;
    const open = await openQuestionIdsOn(tx, args.issueId);
    if (open.length === 0) return null;
    return {
      code: 'OPEN_QUESTIONS',
      detail: `a question was asked on this issue while it was being resumed (${open.join(', ')}), so it stays where it is until that one is answered`,
      details: { to: args.toStatus, openQuestionIds: open },
    };
  }
  if (args.voidQuestions !== undefined && !args.voidQuestions.trim()) {
    return {
      code: 'VOID_REASON_REQUIRED',
      detail:
        '`voidQuestions` is blank. It is the sentence each open question on this issue is voided with, so a reader of the question can tell it died with the work rather than went unanswered — say why they no longer matter, or leave the field out.',
      details: { to: args.toStatus },
    };
  }
  const ids = await openQuestionIdsOn(tx, args.issueId);
  if (ids.length === 0) return null;
  const reason = args.voidQuestions?.trim();
  if (!reason) return openQuestionsFault(ids, args.toStatus);
  await tx
    .update(agentQuestions)
    .set({
      status: 'void',
      voidReason: `the issue went to ${ISSUE_STATUS_LABELS[args.toStatus]} with this question open: ${reason}`,
      endedBy: args.by,
      endedReason: terminal ? QUESTION_ENDED_WITH_ISSUE : QUESTION_NOT_NEEDED,
      updatedAt: new Date(),
    })
    .where(and(inArray(agentQuestions.id, ids), eq(agentQuestions.status, 'open')));
  return null;
}
