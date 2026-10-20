import { eq } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment, withholdForIssue } from '../comments/system-write.js';
import { db } from '../db/client.js';
import { comments, type IssueStatus } from '../db/schema.js';
import { statusLabel } from '../issues/status-sets.js';
import { logger } from '../logger.js';

/** How the agent sessions on a run ended, counted off their rows. */
export interface RunSessionTally {
  completed: number;
  failed: number;
  stopped: number;
  open: number;
}

const sessionCount = (n: number) => (n === 1 ? '1 agent session' : `${n} agent sessions`);

/** What the run's sessions did, from their rows: never a story the records do not tell. */
function sessionsLine(t: RunSessionTally): string {
  const total = t.completed + t.failed + t.stopped + t.open;
  if (total === 0) return 'No agent session has worked this run.';
  const parts = [
    t.completed ? `${t.completed} completed` : null,
    t.failed ? `${t.failed} failed` : null,
    t.stopped ? `${t.stopped} stopped` : null,
    t.open ? `${t.open} still open` : null,
  ].filter((p): p is string => p !== null);
  return `${sessionCount(total)} worked this run: ${parts.join(', ')}.`;
}

export function buildCapReachedCommentBody(args: {
  fromStatus: IssueStatus;
  cap: number;
  sessions: RunSessionTally;
}): string {
  const status = statusLabel(args.fromStatus);
  return [
    `🛑 **Forge has stopped sending this issue back to its agent** — it is now waiting on you.`,
    '',
    `It sat at ${status} with nothing working on it, and Forge sent it back ${args.cap} times on this run without it moving on; another try would most likely end the same way. ${sessionsLine(args.sessions)}`,
    '',
    'What to look at:',
    args.sessions.failed > 0
      ? "- Open the run's sessions from this issue: each one that failed says on its page why it ended."
      : '- Read the last agent session on this issue. An agent that stops here usually hit a decision it could not make alone, or a limit mid-turn.',
    '- If the work is genuinely blocked on an answer, answer it here — the issue resumes from this status on your reply.',
    '- If the work is already done (branch pushed, PR open), close the issue rather than resuming it.',
    '',
    'The count starts again once the issue moves on, so a resumed issue gets every try back.',
  ].join('\n');
}

export async function postCapReachedComment(args: {
  issueId: string;
  fromStatus: IssueStatus;
  cap: number;
  sessions: RunSessionTally;
}): Promise<void> {
  try {
    const written = buildCapReachedCommentBody(args);
    const body = await withholdForIssue(args.issueId, written);
    const existing = await db
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, args.issueId));
    if (existing.some((c) => c.body === body)) return;

    await postSystemComment({
      issueId: args.issueId,
      authorId: await forgeAuthorId(db),
      body: written,
    });
  } catch (err) {
    logger.error({ err, issueId: args.issueId }, 'autonomous-rescue-cap: failed to post comment');
  }
}
