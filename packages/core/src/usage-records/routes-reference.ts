import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { usageRecords } from '../db/schema.js';

export const usageRecordRowSchema = tableRow(usageRecords);

export const usageRecordListSchema = z.object({
  items: z.array(usageRecordRowSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const tokenTotalsSchema = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
  requests: z.number(),
});

export const usageSummarySchema = z.object({
  totals: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    estimatedCost: z.number(),
    requests: z.number(),
  }),
  daily: z.array(tokenTotalsSchema.extend({ date: z.string().describe('UTC day, YYYY-MM-DD') })),
  byModel: z.array(tokenTotalsSchema.extend({ model: z.string() })),
  bySource: z.array(tokenTotalsSchema.extend({ source: z.enum(['cli', 'api', 'desktop']) })),
});

export const bulkCountSchema = z.object({ count: z.number().describe('Records stored') });

export const ingestCliSchema = z.object({
  ingested: z.number(),
  scanned: z.number().describe('Records in the request'),
});

const NOT_MEMBER = 'The caller holds no project role that allows this';
const NO_PROJECT = 'The project does not exist or the caller cannot see it';

export const listUsageRecords = describeOperation({
  summary: 'List a project’s usage records, newest first',
  responses: {
    200: json(usageRecordListSchema, 'One page of records, with the list envelope'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});

export const usageSummary = describeOperation({
  summary: 'Total a project’s usage over the last days, by day, model and source',
  responses: {
    200: json(usageSummarySchema),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});

export const readUsageRecord = describeOperation({
  summary: 'Read one usage record',
  responses: {
    200: json(usageRecordRowSchema),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail(
      'NOT_FOUND',
      'The record does not exist, belongs to no project, or its project cannot be seen',
    ),
  },
});

export const createUsageRecord = describeOperation({
  summary: 'Record one usage entry for a project',
  description: 'The cost is estimated from the model and tokens unless `estimatedCost` is sent.',
  responses: {
    201: json(usageRecordRowSchema, 'The stored record'),
    400: fail('BAD_REQUEST', '`projectId` is missing'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});

export const bulkUsageRecords = describeOperation({
  summary: 'Record up to 500 usage entries at once',
  description: 'The caller needs the member role on every project named; none is stored otherwise.',
  responses: {
    200: json(bulkCountSchema),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});

export const ingestCliUsage = describeOperation({
  summary: 'Record up to 500 usage entries from the CLI',
  description:
    'Like the bulk route, with every record’s source set to `cli` whatever the body says.',
  responses: {
    200: json(ingestCliSchema),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});
