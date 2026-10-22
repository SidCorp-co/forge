// An agent question and the issue it stops are one state: the reads and writes that keep them in step.
//
// Both halves run inside the issue transition's own transaction, so there is one
// writer to `issues.status` and it is `issues/apply-transition.ts`. Nothing here
// moves an issue; it refuses or voids alongside the move that does (ISS-1257).

import {
  AUTONOMOUS_QUESTION_STATUS,
  ISSUE_TERMINAL_STATUSES,
} from '@forge/contracts/issue-machine';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import { QUESTION_MACHINE } from '@forge/contracts/question-machine';
import { isStewardDecisionQuestion } from '@forge/contracts/steward';
import { and, eq, inArray, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { IssueStatus } from '../db/schema.js';
import { agentQuestions, isChoiceStep } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { type KernelActor, transition } from '../lifecycle/index.js';

type Executor = IssueDependencyExecutor;

const QUESTION_ENDED_WITH_ISSUE = 'issue_terminal';
const QUESTION_NOT_NEEDED = 'not_needed';
const QUESTION_PARK_LEFT = 'park_left';
const QUESTION_PARK_REPOINTED = 'park_repointed';
const QUESTION_DRAFT_LEFT = 'draft_left';

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

async function openQuestionIdsOn(executor: Executor, issueId: string): Promise<string[]> {
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

type TerminalQuestionFault = {
  code: 'OPEN_QUESTIONS' | 'VOID_REASON_REQUIRED';
  detail: string;
  details: Record<string, unknown>;
};

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
    /** Who made the issue move the questions die with. */
    actor: KernelActor;
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
  if (!reason) {
    const noun = ids.length === 1 ? 'open question' : 'open questions';
    return {
      code: 'OPEN_QUESTIONS',
      detail: `this issue holds ${ids.length} ${noun} (${ids.join(', ')}), and \`${args.toStatus}\` would leave ${ids.length === 1 ? 'it' : 'them'} asking a person for a decision nothing can act on. Answer ${ids.length === 1 ? 'it' : 'them'} first, or send this move again with \`voidQuestions: "<why they died with the work>"\`, which voids each one with that reason in the same write.`,
      details: { to: args.toStatus, openQuestionIds: ids },
    };
  }
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: `the issue went to ${ISSUE_STATUS_LABELS[args.toStatus]} with this question open: ${reason}`,
      endedBy: args.by,
      endedReason: terminal ? QUESTION_ENDED_WITH_ISSUE : QUESTION_NOT_NEEDED,
      updatedAt: new Date(),
    },
    where: inArray(agentQuestions.id, ids),
    reason,
    actor: args.actor,
    source: 'issues',
    returning: ['id'],
  });
  return null;
}

/**
 * The open questions the park the issue stands at asked: a kernel fact, never a reading of their
 * words. One is the open person question written in the park's own transaction, so its
 * `created_at` is the `created_at` of the issue's latest recorded move into `needs_info` (both are
 * that transaction's `now()`); the other is an open question waiting on an awaited fact — a design
 * revision's decision or a merge mark — which only a park writes, whether it entered the park, was
 * re-pointed there, or was asked again of the revision that superseded the one it waited on. A
 * question anybody asked before or during the park is theirs and is none of these.
 */
function parkQuestionsOf(issueId: string): SQL {
  return and(
    eq(agentQuestions.issueId, issueId),
    eq(agentQuestions.status, 'open'),
    eq(agentQuestions.blockerKind, 'human'),
    sql`(${agentQuestions.awaitsWorkflowId} IS NOT NULL
      OR ${agentQuestions.awaitsMergeIssueId} IS NOT NULL
      OR ${agentQuestions.createdAt} = (
          select max(k.created_at) from kernel_transitions k
           where k.entity = 'issue' and k.entity_id = ${issueId}
             and k.to_status = ${AUTONOMOUS_QUESTION_STATUS}))`,
  ) as SQL;
}

/** One open question the park asked, and the fact that settles it where it waits on one. */
export interface ParkWait {
  questionId: string;
  awaitsDesign: { workflowId: string; revision: number } | null;
  awaitsMerge: { issueId: string } | null;
}

/** What the park the issue stands at waits on: each open question it asked (`parkQuestionsOf`). */
export async function openParkWaitsOn(tx: Executor, issueId: string): Promise<ParkWait[]> {
  const rows = await tx
    .select({
      id: agentQuestions.id,
      workflowId: agentQuestions.awaitsWorkflowId,
      revision: agentQuestions.awaitsRevision,
      mergeIssueId: agentQuestions.awaitsMergeIssueId,
    })
    .from(agentQuestions)
    .where(parkQuestionsOf(issueId))
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  return rows.map((r) => ({
    questionId: r.id,
    awaitsDesign:
      r.workflowId !== null && r.revision !== null
        ? { workflowId: r.workflowId, revision: r.revision }
        : null,
    awaitsMerge: r.mergeIssueId !== null ? { issueId: r.mergeIssueId } : null,
  }));
}

/**
 * Withdraw the questions a park asked (`parkQuestionsOf`), inside the move that takes its issue out
 * of that park, by whichever door makes the move: once the issue stands elsewhere they wait on
 * nothing, and an open row would go on saying a person owes it (REQ-41 BC-11,
 * `VISION: state-never-lies`). A re-point of the park (`issues/park-repoint.ts`) withdraws them the
 * same way, naming what the park waits on now. An answered park has no open question left, so the
 * answer's own resume withdraws nothing.
 */
export async function withdrawParkQuestions(
  tx: Executor,
  args: {
    issueId: string;
    toStatus: IssueStatus;
    /** The move's own reason, in the mover's words; null when the move gave none. */
    reason: string | null;
    by: string;
    actor: KernelActor;
    /** The park stays where it is and waits on this instead: a re-point, not a move. */
    repointedTo?: string | undefined;
  },
): Promise<string[]> {
  const open = await tx
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(parkQuestionsOf(args.issueId));
  if (open.length === 0) return [];
  const ids = open.map((r) => r.id);
  const why = args.reason?.trim();
  const sentence = args.repointedTo
    ? `the park that asked this was re-pointed to wait on ${args.repointedTo} instead, so it no longer waits on this${why ? `: ${why}` : ''}`
    : `the issue moved from ${ISSUE_STATUS_LABELS[AUTONOMOUS_QUESTION_STATUS]} to ${ISSUE_STATUS_LABELS[args.toStatus]} without this being answered, so the park that asked it no longer waits on a person${why ? `: ${why}` : ''}`;
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: sentence,
      endedBy: args.by,
      endedReason: args.repointedTo ? QUESTION_PARK_REPOINTED : QUESTION_PARK_LEFT,
      updatedAt: new Date(),
    },
    where: inArray(agentQuestions.id, ids),
    reason: sentence,
    actor: args.actor,
    source: 'issues',
    returning: ['id'],
  });
  return ids;
}

/**
 * Void the steward's open take-on-or-drop decisions on an issue, inside the move that takes it out of
 * `draft`, by whichever door makes the move: the decision asked what to do with the draft, and once
 * it is not one an answer has nothing to act on, while an open row would go on listing it in Needs
 * you and the chat would go on recommending it (REQ-41 BC-26, `VISION: state-never-lies`). Only a
 * question whose round offers the steward's fixed decisions is one; a person's or a run's question
 * on the issue stays open. A move made by answering the decision answers it first, in the same
 * transaction, so nothing is left here to void.
 */
export async function voidStewardDraftQuestions(
  tx: Executor,
  args: {
    issueId: string;
    toStatus: IssueStatus;
    /** The move's own reason, in the mover's words; null when the move gave none. */
    reason: string | null;
    by: string;
    actor: KernelActor;
  },
): Promise<string[]> {
  const open = await tx
    .select({ id: agentQuestions.id, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.issueId, args.issueId), eq(agentQuestions.status, 'open')));
  const ids = open
    .filter((q) => {
      const round = q.steps.at(-1);
      return round !== undefined && isChoiceStep(round) && isStewardDecisionQuestion(round.options);
    })
    .map((q) => q.id);
  if (ids.length === 0) return [];
  const why = args.reason?.trim();
  const sentence = `the issue moved from ${ISSUE_STATUS_LABELS.draft} to ${ISSUE_STATUS_LABELS[args.toStatus]} without this being answered, so the draft it asked about is gone and no answer to it can act${why ? `: ${why}` : ''}`;
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: sentence,
      endedBy: args.by,
      endedReason: QUESTION_DRAFT_LEFT,
      updatedAt: new Date(),
    },
    where: inArray(agentQuestions.id, ids),
    reason: sentence,
    actor: args.actor,
    source: 'issues',
    returning: ['id'],
  });
  return ids;
}

const QUESTION_ENDED_WITH_RUN = 'run_cancelled';

/**
 * Void the open questions a cancelled run leaves: those its sessions asked and, for an issue run,
 * those on its issue. Called inside the cancel's own transaction (agent-run-standing, `cancelled`:
 * its open questions are voided), so a cancel that rolls back keeps them open.
 */
export async function voidCancelledRunQuestions(
  tx: Executor,
  args: {
    issueId: string | null;
    sessionIds: readonly string[];
    reason: string;
    actor: KernelActor;
    source: string;
  },
): Promise<string[]> {
  const owners: SQL[] = [];
  if (args.issueId) owners.push(eq(agentQuestions.issueId, args.issueId));
  if (args.sessionIds.length > 0) {
    owners.push(inArray(agentQuestions.agentSessionId, [...args.sessionIds]));
  }
  if (owners.length === 0) return [];
  const owned = owners.length === 1 ? owners[0] : sql`(${sql.join(owners, sql` OR `)})`;
  const open = await tx
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.status, 'open'), owned));
  if (open.length === 0) return [];
  const ids = open.map((r) => r.id);
  await transition(tx, QUESTION_MACHINE, {
    to: 'void',
    from: 'open',
    set: {
      voidReason: `the run that asked was cancelled (${args.reason})`,
      endedBy: args.actor.id ?? args.actor.type,
      endedReason: QUESTION_ENDED_WITH_RUN,
      updatedAt: new Date(),
    },
    where: inArray(agentQuestions.id, ids),
    reason: args.reason,
    actor: args.actor,
    source: args.source,
    returning: ['id'],
  });
  return ids;
}
