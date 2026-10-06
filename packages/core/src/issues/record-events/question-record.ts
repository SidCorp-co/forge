// A `forge-record: question` comment is a question the run asked, so it is a Question row: the HOP
// run's master asked the owner through one (8e5533b8 on ISS-1), no row was written, and the issue
// read "a person paused it" while the owner was the one owed (FB-55's class). The row is keyed by
// the comment's own id, so a re-mirror of the same comment asks nothing twice.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import type { ForgeRecord } from '../../messaging/forge-record.js';
import type { Actor } from '../activity.js';
import { askParkQuestion } from '../ports.js';

/** Addressees a question record names that are not a person: the run asks itself nothing. */
const AGENT_ADDRESSEES = new Set(['agent', 'run', 'master', 'self']);

/**
 * A round's text on one line: the `role:ask` screen refuses a newline in any part of a round
 * (`messaging/text-rules.ts:SINGLE_LINE`), and the full text stays in the comment that asked.
 */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function promptOf(record: ForgeRecord, body: string): string {
  const named = record.fields.find((f) => f.key === 'prompt' || f.key === 'question')?.value;
  if (named?.trim()) return oneLine(named);
  const prose = oneLine(
    `${body.slice(0, record.at)} ${body.slice(record.to)}`
      .replace(/^#+\s*question\s*$/gim, '')
      .replace(/`forge-record:[^`]*`/g, ''),
  );
  return prose || 'The run asked which of these readings holds.';
}

function neededOf(record: ForgeRecord): string {
  const readings = record.fields.filter((f) => f.key === 'reading').map((f) => f.value.trim());
  const needed = record.fields.find((f) => f.key === 'needs' || f.key === 'needed')?.value.trim();
  if (readings.length === 0) {
    return (
      (needed && oneLine(needed)) ||
      'the run did not say what would settle this — answer with whatever it needs to carry on'
    );
  }
  const listed = readings.map((r, i) => `(${i + 1}) ${oneLine(r)}`).join('; ');
  return `${needed ? `${oneLine(needed)}; ` : ''}which reading holds, by number or in your own words: ${listed}`;
}

/** The question row a comment already is, by its id, where one was minted for it. */
async function questionExists(tx: Tx, commentId: string): Promise<boolean> {
  const asked = (await tx.execute(
    sql`SELECT 1 FROM agent_questions WHERE id = ${commentId}`,
  )) as unknown as unknown[];
  return asked.length > 0;
}

/** The issue a question would stop, or the warning owed where the work is finished. */
async function liveIssueOf(
  tx: Tx,
  issueId: string,
  what: string,
): Promise<{ projectId: string } | { warning: string } | null> {
  const [issue] = await tx
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) return null;
  if (ISSUE_TERMINAL_STATUSES.includes(issue.status as IssueStatus)) {
    return {
      warning: `QUESTION_ISSUE_TERMINAL: ${what} is stored as prose only — the issue is \`${issue.status}\`, so no answer could reach the work it asks about`,
    };
  }
  return { projectId: issue.projectId };
}

/**
 * An agent's `intent: question` comment is a question a person owes an answer to (ISS-260, FB-55):
 * a free-text Question keyed by the comment's own id, so `GET /api/questions/<comment id>` reads it
 * and `POST /api/questions/<comment id>/answer` answers it. A comment whose question fence already
 * minted the row asks nothing twice. A person's question comment is owed an agent's reply instead
 * (`devices/comment-inbox.ts`), and mints nothing.
 */
export async function mintCommentQuestion(
  comment: { id: string; issueId: string; body: string },
  tx: Tx,
): Promise<string[]> {
  const issue = await liveIssueOf(tx, comment.issueId, 'this `intent: question` comment');
  if (!issue) return [];
  if ('warning' in issue) return [issue.warning];
  if (await questionExists(tx, comment.id)) return [];
  await askParkQuestion(tx, {
    id: comment.id,
    projectId: issue.projectId,
    issueId: comment.issueId,
    prompt: oneLine(comment.body) || 'The run asked a question in the thread.',
    needed:
      'the answer to the question in this comment — the run that asked reads it on this question',
  });
  return [];
}

export async function mintRecordQuestion(
  comment: { id: string; issueId: string; body: string },
  record: ForgeRecord,
  actor: Actor,
  tx: Tx,
): Promise<string[]> {
  if (actor.agency !== 'agent') return [];
  const to =
    record.fields
      .find((f) => f.key === 'to')
      ?.value.trim()
      .toLowerCase() ?? '';
  if (AGENT_ADDRESSEES.has(to)) return [];
  const issue = await liveIssueOf(tx, comment.issueId, "this comment's `forge-record: question`");
  if (!issue) return [];
  if ('warning' in issue) return [issue.warning];
  if (await questionExists(tx, comment.id)) return [];
  await askParkQuestion(tx, {
    id: comment.id,
    projectId: issue.projectId,
    issueId: comment.issueId,
    prompt: promptOf(record, comment.body),
    needed: neededOf(record),
  });
  return [];
}
