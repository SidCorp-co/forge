import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, type IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';

export function buildCapReachedCommentBody(args: {
  fromStatus: IssueStatus;
  cap: number;
  driveSessions: number;
}): string {
  return [
    `🛑 **The driver stopped at \`${args.fromStatus}\` ${args.cap} times without finishing** — this issue is now waiting on you.`,
    '',
    `Each time, the \`drive\` job exited cleanly but left the issue at \`${args.fromStatus}\` with no work queued behind it, so nothing in the pipeline could carry it forward. The reconciler re-entered the driver ${args.cap} times; a ${args.cap + 1}th would mint another session with no reason to expect a different ending.`,
    '',
    'What to look at:',
    '- Read the last drive session on this issue. An agent that stops here usually hit a decision it could not make alone, or a limit mid-turn.',
    '- If the work is genuinely blocked on an answer, answer it here — the issue resumes from this status on your reply.',
    '- If the work is already done (branch pushed, PR open), close the issue rather than resuming it.',
    '',
    `Rescue counting resets once the issue moves on, so a resumed issue gets a full allowance again. This run has burned ${args.driveSessions} drive sessions so far.`,
  ].join('\n');
}

export async function postCapReachedComment(args: {
  issueId: string;
  authorId: string;
  fromStatus: IssueStatus;
  cap: number;
  driveSessions: number;
}): Promise<void> {
  try {
    const body = buildCapReachedCommentBody(args);
    const existing = await db
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, args.issueId));
    // cm:guard idempotent by BODY, not by a flag: the park transition can race a concurrent reconciler tick, and a second identical comment on an issue a human is being asked to read is how an operator-facing signal turns into noise they filter out.
    // cm:guard which is why `driveSessions` is IN the body and must stay there. Every other input is stable across a run, so a body built without it is byte-identical at every park — and the SECOND park, after a human answered and the counter reset, silently posts nothing. The issue then flips to `needs_info` carrying only the previous cycle's explanation. The watermark is strictly increasing, so a later park always differs while a same-tick race still collides, which is the only collision this guard wants.
    if (existing.some((c) => c.body === body)) return;

    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: args.authorId,
      body,
    });
  } catch (err) {
    logger.error({ err, issueId: args.issueId }, 'autonomous-rescue-cap: failed to post comment');
  }
}
