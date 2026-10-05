import type { IssueStatus } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { postIssueNoticeOnce } from './ports.js';

function buildCapReachedCommentBody(args: {
  fromStatus: IssueStatus;
  cap: number;
  runSessions: number;
}): string {
  return [
    `🛑 **${args.runSessions} run sessions ended on this issue without it moving on** — it stopped at \`${args.fromStatus}\` and is now waiting on you.`,
    '',
    `Each run session handed the issue back without delivering it, so nothing in the pipeline could carry it forward. The cap is ${args.cap}; another run would have no reason to expect a different ending.`,
    '',
    'What to look at:',
    '- Read the last run session on this issue. An agent that stops here usually hit a decision it could not make alone, or a limit mid-turn.',
    '- If the work is genuinely blocked on an answer, answer it here — the issue resumes from this status on your reply.',
    '- If the work is already done (branch pushed, PR open), close the issue rather than resuming it.',
    '',
    'Counting resets once the issue moves on (a park, a delivery or a reopen), so an answered issue gets a full allowance again.',
  ].join('\n');
}

export async function postCapReachedComment(args: {
  issueId: string;
  authorId: string;
  fromStatus: IssueStatus;
  cap: number;
  runSessions: number;
}): Promise<void> {
  try {
    const body = buildCapReachedCommentBody(args);
    await postIssueNoticeOnce({
      issueId: args.issueId,
      authorId: args.authorId,
      body,
      marker: body,
    });
  } catch (err) {
    logger.error({ err, issueId: args.issueId }, 'autonomous-rescue-cap: failed to post comment');
  }
}
