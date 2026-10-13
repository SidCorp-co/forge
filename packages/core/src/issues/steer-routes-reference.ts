import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const steerResultSchema = z.object({
  agentSessionId: z.string(),
  jobId: z.string(),
  commentId: z.string(),
  seq: z.number(),
  duplicate: z.boolean(),
});

export const steerIssueRoute = describeOperation({
  summary: 'Send a message into the agent session that is working this issue',
  description:
    "The text is also posted as a comment on the issue, which is the send's idempotency key.",
  responses: {
    200: json(steerResultSchema, '`duplicate` is true when the same send had already been made'),
    400: fail({
      BODY_INVALID: 'the text cannot be read as a comment body',
      MESSAGE_REFUSED: 'the text is refused by the comment write door',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail({
      NOT_FOUND: 'the issue does not exist',
      NO_LIVE_SESSION: 'no live agent session is working the issue',
    }),
    409: fail({
      SESSION_PARKED: 'the session is waiting on an answer; a comment on the issue delivers it',
      NO_DEVICE: 'the session has no device to deliver to',
    }),
  },
});
