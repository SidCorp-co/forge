// An agent question and the issue it stops are one state: the reads and writes that keep them in step.
//
// Both halves run inside the issue transition's own transaction, so there is one
// writer to `issues.status` and it is `issues/apply-transition.ts`. Nothing here
// moves an issue; it refuses or voids alongside the move that does (ISS-1257).

import { and, eq, inArray } from 'drizzle-orm';
import type { IssueStatus } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/dependency-executor.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';

type Executor = IssueDependencyExecutor;

export const QUESTION_ENDED_WITH_ISSUE = 'issue_terminal';

export async function openQuestionIdsOn(executor: Executor, issueId: string): Promise<string[]> {
  const rows = await executor
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.issueId, issueId), eq(agentQuestions.status, 'open')))
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  return rows.map((r) => r.id);
}

export type TerminalQuestionFault = {
  code: 'OPEN_QUESTIONS' | 'VOID_REASON_REQUIRED';
  detail: string;
  details: Record<string, unknown>;
};

/**
 * Refuse a terminal move while the issue holds an open question, or void those
 * questions with the reason the caller gave for their dying with the work; and,
 * with `requireNoOpenQuestions`, refuse any move while one is open (the answer resume).
 *
 * The caller holds the issue row locked, so an ask racing this move either
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
  if (!ISSUE_TERMINAL_STATUSES.includes(args.toStatus)) {
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
  if (!reason) {
    const noun = ids.length === 1 ? 'open question' : 'open questions';
    return {
      code: 'OPEN_QUESTIONS',
      detail: `this issue holds ${ids.length} ${noun} (${ids.join(', ')}), and \`${args.toStatus}\` would leave ${ids.length === 1 ? 'it' : 'them'} asking a person for a decision nothing can act on. Answer ${ids.length === 1 ? 'it' : 'them'} first, or send this move again with \`voidQuestions: "<why they died with the work>"\`, which voids each one with that reason in the same write.`,
      details: { to: args.toStatus, openQuestionIds: ids },
    };
  }
  await tx
    .update(agentQuestions)
    .set({
      status: 'void',
      voidReason: `the issue went to \`${args.toStatus}\` with this question open: ${reason}`,
      endedBy: args.by,
      endedReason: QUESTION_ENDED_WITH_ISSUE,
      updatedAt: new Date(),
    })
    .where(and(inArray(agentQuestions.id, ids), eq(agentQuestions.status, 'open')));
  return null;
}
