import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { okSchema } from './routes-reference.js';

export const paramSchema = z.object({ id: z.uuid(), seq: z.coerce.number().int().positive() });
export const ackBodySchema = z.object({ outcome: z.enum(['delivered', 'gone']) });
export const appliedBodySchema = z.object({ turn: z.number().int().nonnegative() });

const notOnDevice = fail('FORBIDDEN', 'the session is not on this device');

export const ackInboxSend = describeOperation({
  summary: 'Confirm that a send in the session inbox reached the box, or that its pane was gone',
  responses: { 200: json(okSchema), 403: notOnDevice },
});

export const applyInboxSend = describeOperation({
  summary: 'Record the turn a send in the session inbox was applied as',
  responses: { 200: json(okSchema), 403: notOnDevice },
});
