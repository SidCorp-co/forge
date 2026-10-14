import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { jobEventKinds, jobEvents } from '../db/schema.js';

export const jobIdParamSchema = z.object({ id: z.uuid() });

export const eventInputSchema = z.object({
  kind: z.enum(jobEventKinds),
  data: z.record(z.string(), z.unknown()).default({}),
  ts: z.iso.datetime().optional(),
});

export const eventBatchSchema = z
  .object({
    events: z.array(eventInputSchema).min(1).max(100),
  })
  .strict();

export const eventsListQuerySchema = z
  .object({
    sinceSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

export const eventListSchema = z.object({
  items: z.array(tableRow(jobEvents)),
  lastSeq: z.number(),
});

export const eventsAcceptedSchema = z.object({
  accepted: z.number(),
  firstSeq: z.number().nullable(),
  lastSeq: z.number().nullable(),
});

export const listJobEvents = describeOperation({
  summary: "List a job's events in order, optionally after a sequence number",
  description: '`lastSeq` is the cursor to pass as `sinceSeq` next time.',
  responses: {
    200: json(eventListSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the job's project"),
    404: fail('NOT_FOUND', 'no such job'),
  },
});

export const postJobEvents = describeOperation({
  summary: 'Append a batch of events from the box running a job',
  description:
    'The first batch also acknowledges the job for a runner that sends no ack. Partial stream frames are dropped, not stored.',
  responses: {
    200: json(eventsAcceptedSchema, '`accepted` counts the events stored'),
    403: fail('FORBIDDEN', 'the job is not dispatched to this device'),
    404: fail('NOT_FOUND', 'no such job'),
    409: fail('JOB_TERMINATED', 'the job already ended'),
  },
});
