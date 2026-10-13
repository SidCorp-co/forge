import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

/** How many lines one POST may carry, matching the runner's own chunking. */
const MAX_BATCH = 100;

export const eventInputSchema = z
  .object({
    seq: z.number().int().min(1),
    kind: z.literal('stdout'),
    data: z.record(z.string(), z.unknown()),
    ts: z.iso.datetime().optional(),
  })
  .strict();

export const eventBatchSchema = z
  .object({
    events: z.array(eventInputSchema).min(1).max(MAX_BATCH),
  })
  .strict();

export const linesAcceptedSchema = z.object({
  accepted: z.number(),
  duplicates: z.number(),
  firstSeq: z.number().nullable(),
  lastSeq: z.number().nullable(),
});

export const postSessionEvents = describeOperation({
  summary: 'Deliver the stream-json lines a chat turn produced, from the device that ran it',
  description:
    'Lines are numbered by the runner; a seq already stored is counted in `duplicates`, not an error. Core folds them into the transcript.',
  responses: {
    200: json(linesAcceptedSchema),
    400: fail(
      'UNREPRESENTABLE_LINE',
      'a line has no `data.line` object with a `type`, or a seq repeats in the batch',
    ),
    403: fail('FORBIDDEN', 'the caller is not a device, or not the one the session is on'),
    404: fail('NOT_FOUND', 'no such agent session'),
    409: fail({
      SESSION_TERMINATED: 'the session already ended',
      SEQ_TAKEN_BY_CORE: 'a seq in the batch is held by a row core wrote',
    }),
  },
});
