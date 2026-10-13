import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { feedbackReports } from '../db/schema.js';

/** A report as the feed shows it: the ids of the run that wrote it are left out and dates are ISO strings. */
export const feedbackReportSchema = tableRow(feedbackReports)
  .pick({
    id: true,
    kind: true,
    severity: true,
    target: true,
    targetRef: true,
    summary: true,
    detail: true,
    suggestion: true,
    signalKey: true,
    sessionId: true,
    linkedIssueId: true,
  })
  .extend({
    projectId: z.string().optional(),
    projectSlug: z.string().nullable().optional(),
    reviewedAt: z.string().nullable(),
    createdAt: z.string(),
  });

export const reviewedStampSchema = z.object({
  id: z.string(),
  reviewedAt: z.string().nullable(),
  linkedIssueId: z.string().nullable(),
});

export const listFeedbackReports = describeOperation({
  summary: "A project's friction reports, newest first, or every visible project's with scope=all",
  description:
    '`projectId` is required unless `scope` is `all`. `projectId` and `projectSlug` are on each report only under `scope=all`.',
  responses: {
    200: json(z.array(feedbackReportSchema), 'Newest first, at most `limit` (50 by default)'),
    400: fail('BAD_REQUEST', 'neither a projectId nor scope=all was sent'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'there is no such project'),
  },
});

export const reviewFeedbackReport = describeOperation({
  summary: 'Mark a report reviewed or not, optionally linking the issue it was curated into',
  description: 'Clearing the mark clears the link too. Project members and above.',
  responses: {
    200: json(reviewedStampSchema, 'The report as stamped'),
    400: fail('BAD_REQUEST', 'the id in the path is not a uuid'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail(
      'NOT_FOUND',
      'there is no such report or project, or the linked issue is in no project the caller sees',
    ),
  },
});
