// A park question that waits on an issue's merge mark, and the stamp that answers it.
//
// The question names the issue whose mark it waits on when it is asked: nothing here reads a prompt
// for one. Whatever writes the mark — a merge Forge observed, a mark, a design approval recorded as
// the landing — answers the question in the stamp's own transaction, and `question.answered` carries
// the answer to the consumers a person's answer reaches. A mark that already stands settles nothing
// still owed, so a park naming one is refused rather than left waiting on what already holds.

import type { OutboxActor } from '@forge/contracts/outbox-events';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { answerWaitingQuestions } from './answer-record.js';

/** The issue whose merge mark answers a question. */
export interface AwaitedMerge {
  issueId: string;
}

/** The mark as its stamp left it: what the answer names. */
export interface StampedMark {
  mergedAt: Date | string | null;
  commitSha: string | null;
  landing: string | null;
}

/** Why an ask may not wait on the mark it names: the code it is refused with, and the sentence. */
export interface AwaitedMergeFault {
  code: 'QUESTION_MERGE_UNKNOWN' | 'QUESTION_MERGE_ALREADY_MARKED';
  detail: string;
}

const isoOf = (at: Date | string) => (at instanceof Date ? at : new Date(at)).toISOString();

/** The mark in a reader's words: the commit, the landing, or a mark carrying neither, and when. */
function markWords(mark: StampedMark): string {
  const at = mark.mergedAt ? ` at ${isoOf(mark.mergedAt)}` : '';
  if ((mark.commitSha ?? '').trim()) return `commit ${mark.commitSha}${at}`;
  if ((mark.landing ?? '').trim()) return `landing ${mark.landing}${at}`;
  return `a mark naming no commit and no landing${at}`;
}

/**
 * Why an ask naming this issue's mark is refused, or the issue's key where the mark is still owed.
 *
 * The issue row is read `for share`, so a stamp racing this ask either committed first and is seen
 * here, or waits for this transaction and then finds the question it wrote.
 */
export async function awaitedMergeFault(
  executor: IssueDependencyExecutor,
  projectId: string,
  awaited: AwaitedMerge,
): Promise<{ fault: AwaitedMergeFault } | { key: string }> {
  const rows = (await executor.execute(sql`
    SELECT i.project_id, i.iss_seq, i.merged_at, i.merged_commit_sha, i.merged_landing, p.issue_prefix
      FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.id = ${awaited.issueId}
       FOR SHARE OF i
  `)) as unknown as Array<{
    project_id: string;
    iss_seq: number | string;
    merged_at: Date | string | null;
    merged_commit_sha: string | null;
    merged_landing: string | null;
    issue_prefix: string | null;
  }>;
  const row = rows[0];
  if (!row || String(row.project_id) !== projectId) {
    return {
      fault: {
        code: 'QUESTION_MERGE_UNKNOWN',
        detail: `\`awaitsMerge\` names issue ${awaited.issueId}, which is not an issue of this issue's project — name an issue of project ${projectId} whose merge mark settles this park`,
      },
    };
  }
  const key = formatIssueRef(row.issue_prefix, Number(row.iss_seq));
  if (row.merged_at !== null) {
    const mark = markWords({
      mergedAt: row.merged_at,
      commitSha: row.merged_commit_sha,
      landing: row.merged_landing,
    });
    return {
      fault: {
        code: 'QUESTION_MERGE_ALREADY_MARKED',
        detail: `${key} already carries its merge mark (${mark}), so a question waiting on it would wait on a condition that already holds — take the move the mark settles now, or ask without \`awaitsMerge\``,
      },
    };
  }
  return { key };
}

/** What settles a question that waits on a mark, said where `needs` gave nothing. */
export function neededForMerge(key: string): string {
  return `the merge mark of ${key} — recording it (a merge Forge observes, a mark, or a design approval recorded as its landing) answers this question`;
}

/** The answer a stamp writes on the questions waiting on it. */
export function markAnswer(key: string, mark: StampedMark): string {
  return `The merge mark of ${key} was recorded: ${markWords(mark)}.`;
}

/**
 * Answer every open question waiting on this issue's mark with the mark just stamped. Called inside
 * the stamp's transaction, so the mark and its answers commit together or not at all.
 */
export async function answerMergeQuestions(
  tx: Tx,
  args: { issueId: string; mark: StampedMark; actor: OutboxActor | null },
): Promise<string[]> {
  if (args.mark.mergedAt === null) return [];
  const rows = await tx
    .select()
    .from(agentQuestions)
    .where(
      and(eq(agentQuestions.status, 'open'), eq(agentQuestions.awaitsMergeIssueId, args.issueId)),
    )
    .orderBy(agentQuestions.createdAt, agentQuestions.id)
    .for('update');
  if (rows.length === 0) return [];
  const [issue] = (await tx.execute(sql`
    SELECT i.iss_seq, p.issue_prefix, p.created_by FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.id = ${args.issueId}
  `)) as unknown as Array<{
    iss_seq: number | string;
    issue_prefix: string | null;
    created_by: string;
  }>;
  if (!issue) throw new Error(`questions: issue ${args.issueId} vanished under its own stamp`);
  const body = markAnswer(formatIssueRef(issue.issue_prefix, Number(issue.iss_seq)), args.mark);
  // an answer is an account's: a stamp a device or core wrote answers on the project owner's
  // behalf, as a host-reported merge is recorded (`issues/host-merge.ts`)
  const answerer =
    args.actor?.type === 'user'
      ? { id: args.actor.id, agency: args.actor.agency }
      : { id: String(issue.created_by), agency: 'agent' as const };
  return answerWaitingQuestions(tx, rows, {
    body,
    by: answerer.id,
    agency: answerer.agency,
    source: 'issues',
    waitsOn: 'a merge mark',
  });
}
