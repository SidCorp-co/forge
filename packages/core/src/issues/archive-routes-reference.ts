import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { issueStatuses } from '../db/schema.js';

const status = z.enum(issueStatuses);

const refusalSchema = z.union([
  z.object({
    kind: z.literal('unknown_key'),
    field: z.enum(['keys', 'exclude']),
    key: z.string(),
    message: z.string(),
  }),
  z.object({ kind: z.literal('status_not_terminal'), status, message: z.string() }),
  z.object({ kind: z.literal('not_terminal'), key: z.string(), status, message: z.string() }),
  z.object({
    kind: z.literal('load_bearing_edge'),
    key: z.string(),
    edgeId: z.string(),
    edgeKind: z.string(),
    direction: z.enum(['outgoing', 'incoming']),
    other: z.string(),
    otherStatus: status,
    message: z.string(),
  }),
]);

/** What an archive or an unarchive did, or on a dry run would do. */
export const archiveReportSchema = z.object({
  direction: z.enum(['archive', 'unarchive']),
  dryRun: z.boolean(),
  matched: z.array(z.string()),
  unmatchedKeys: z.array(z.string()),
  changed: z.array(z.string()),
  unchanged: z.array(z.string()),
  refusals: z.array(refusalSchema),
});

const describe = (summary: string) =>
  describeOperation({
    summary,
    description:
      'Takes a filter and a `dryRun`. A refusal leaves every issue as it was; the report that says why is in `details` of the 409.',
    responses: {
      200: json(
        archiveReportSchema,
        '`changed` holds the keys moved, or on a dry run the keys that would be',
      ),
      403: fail('FORBIDDEN', 'the caller is not a project admin'),
      404: fail('NOT_FOUND', 'the project does not exist'),
      409: fail(
        'ARCHIVE_REFUSED',
        'the filter names an unknown key or a status that cannot be moved, or a matched issue is held by an open edge',
      ),
    },
  });

export const archiveIssues = describe('Archive the closed or dropped issues a filter matches');
export const unarchiveIssues = describe('Bring the archived issues a filter matches back');
