import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

export const paramSchema = z.object({ id: z.uuid() });

export const turnVerdictSchema = z.object({ done: z.boolean() });

export const readTurnVerdict = describeOperation({
  summary: 'Ask whether the box may end the job now or the issue is waiting on an answer',
  description:
    "`done` is false while the issue sits at the status that waits for a question's answer.",
  responses: {
    200: json(turnVerdictSchema),
    403: fail('FORBIDDEN', 'the job is not dispatched to this device'),
    404: fail('NOT_FOUND', 'no such job'),
  },
});
