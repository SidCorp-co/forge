import { eq } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment, withholdForIssue } from '../comments/system-write.js';
import { db } from '../db/client.js';
import { comments, type IssueStatus } from '../db/schema.js';
import { statusLabel } from '../issues/status-sets.js';
import { logger } from '../logger.js';

export function buildCapReachedCommentBody(args: {
  fromStatus: IssueStatus;
  cap: number;
  driveSessions: number;
}): string {
  return [
    `🛑 **The agent working on this issue stopped at ${statusLabel(args.fromStatus)} ${args.cap} times without finishing** — this issue is now waiting on you.`,
    '',
    `Each time, the agent finished without an error but left the issue at ${statusLabel(args.fromStatus)} with no work queued behind it, so nothing could carry it forward. Forge started it again ${args.cap} times; another try would most likely end the same way.`,
    '',
    'What to look at:',
    '- Read the last agent session on this issue. An agent that stops here usually hit a decision it could not make alone, or a limit mid-turn.',
    '- If the work is genuinely blocked on an answer, answer it here — the issue resumes from this status on your reply.',
    '- If the work is already done (branch pushed, PR open), close the issue rather than resuming it.',
    '',
    `The count starts again once the issue moves on, so a resumed issue gets every try back. ${args.driveSessions === 1 ? '1 agent session has' : `${args.driveSessions} agent sessions have`} worked on it so far.`,
  ].join('\n');
}

export async function postCapReachedComment(args: {
  issueId: string;
  fromStatus: IssueStatus;
  cap: number;
  driveSessions: number;
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
