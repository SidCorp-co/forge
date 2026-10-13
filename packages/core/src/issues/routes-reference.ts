import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyNodeSchema } from '../body/routes-reference.js';
import { jobStatuses } from '../db/job-vocabulary.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  jobs,
  landingShapes,
} from '../db/schema.js';
import { paginationSchema } from '../lib/pagination.js';
import { CREATE_ENTRY_STATUSES } from './create-service.js';
import { attachmentInputSchema, labelAttachItemSchema } from './input-schemas.js';
import { landingShapeInputSchema } from './landing-evidence.js';
import { issueMetadataSchema } from './metadata.js';
import { issueRelationInputSchema } from './relations-service.js';
import { ReleaseNotesSchema } from './release-notes.js';
import {
  agentSessionSchema,
  agentStatusSchema,
  creatorFields,
  ISSUE_REF_REFUSALS,
  issueLabelSchema,
  issueListRowSchema,
  issueRowSchema,
  liveReachSchema,
  mergeMarkSchema,
  pipelineHealthSchema,
} from './search-reference.js';
import { sessionContextExpectSchema, sessionContextSchema } from './session-context.js';
import { issueSortValues } from './sort.js';

export const issueCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    reportedBy: z.string().trim().min(1).max(200).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    detectorKey: z.string().trim().min(1).max(120).optional(),
    relations: z.array(issueRelationInputSchema).max(20).optional(),
    status: z.enum(CREATE_ENTRY_STATUSES).optional(),
  })
  .strict();

export type IssueCreateInput = z.infer<typeof issueCreateSchema>;

export const issuePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    metadata: issueMetadataSchema.optional(),
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    sessionContext: sessionContextSchema,
    detectorKey: z.string().trim().min(1).max(120).optional(),
    landingShape: landingShapeInputSchema.optional(),
    expect: sessionContextExpectSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' })
  .refine((o) => Object.keys(o).some((k) => k !== 'expect'), {
    message: '`expect` is a precondition on a write — send the field(s) to write alongside it',
  });

export type IssuePatchInput = z.infer<typeof issuePatchSchema>;

const issueKeyFilterSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?\d{1,10}$/,
    'expected a display id like `ISS-42`, or its bare sequence number',
  );

export const issueFiltersSchema = paginationSchema
  .extend({
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    assigneeId: z.uuid().optional(),
    category: z.string().trim().min(1).max(100).optional(),
    key: issueKeyFilterSchema.optional(),
    sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
    withAgentSessions: z.coerce.boolean().optional().default(false),
    /** ISS-1237 — archived issues are left out unless asked for; a `key` is retrieval and always answers. */
    includeArchived: z.stringbool().optional(),
  })
  .strict();

export type IssueFilters = z.infer<typeof issueFiltersSchema>;

/** An issue row as `serializeIssue` sends it: every column, plus what the row implies. */
export const issueViewSchema = issueRowSchema.extend({
  displayId: z.string(),
  descriptionNodes: z.array(bodyNodeSchema).nullable(),
  mergeMark: mergeMarkSchema,
  landingShape: z.enum(landingShapes),
});

const issueDetailFields = {
  ...creatorFields,
  pipelineHealth: pipelineHealthSchema,
  liveReach: liveReachSchema.nullable(),
  labels: z.array(issueLabelSchema),
  comments: z.array(z.never()),
  activity: z.array(z.never()),
};

/** One issue with its labels and pipeline health; `comments` and `activity` are always empty here. */
export const issueByDisplaySchema = issueViewSchema.extend(issueDetailFields);

export const issueDetailSchema = issueByDisplaySchema.extend({
  agentSessions: z.array(agentSessionSchema),
  agentStatus: agentStatusSchema,
});

/** A page of the project's issues, with the page bound they were read under. */
export const issueListSchema = z.object({
  items: z.array(
    issueListRowSchema.extend({
      ...creatorFields,
      pipelineHealth: pipelineHealthSchema,
      agentSessions: z.array(agentSessionSchema).optional(),
      agentStatus: agentStatusSchema.optional(),
    }),
  ),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

const persistedAttachmentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  uploaderId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: z.date(),
  url: z.string(),
});

const relationAppliedSchema = z.object({
  edgeId: z.string(),
  kind: z.enum(['blocks', 'relates']),
  fromIssueId: z.string(),
  toIssueId: z.string(),
  created: z.boolean(),
  updated: z.boolean(),
});

/** A created issue, with what was attached and linked in the same call. */
export const createdIssueSchema = issueViewSchema.extend({
  attachments: z.array(persistedAttachmentSchema),
  attachmentErrors: z
    .array(
      z.object({
        index: z.number(),
        name: z.string(),
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    )
    .optional(),
  relations: z.array(relationAppliedSchema).optional(),
  warnings: z.array(z.string()).optional(),
});

/** What a create answers when the detector key already stands for an issue. */
export const dedupedIssueSchema = z.object({
  deduped: z.literal(true),
  detectorKey: z.string(),
  existingIssueId: z.string(),
  existingIssueDisplayId: z.string().nullable(),
  existingIssueStatus: z.string().nullable(),
});

export const patchedIssueSchema = issueViewSchema.extend({
  warnings: z.array(z.string()).optional(),
});

export const jobHistorySchema = z.array(
  z.object({
    jobId: z.string(),
    status: z.enum(jobStatuses),
    model: tableRow(jobs).shape.modelUsed,
    startedAt: z.date().nullable(),
    finishedAt: z.date().nullable(),
    estTokens: z.number().nullable(),
    tokens: z.number(),
    cost: z.number(),
  }),
);

const NOT_A_MEMBER = fail('FORBIDDEN', "the caller is not a member of the issue's project");
const NO_SUCH_ISSUE = fail('NOT_FOUND', 'the issue does not exist');

/** Everything an edge, a label, an attachment or a body can be refused for on a write to an issue. */
const WRITE_REFUSALS = {
  ASSIGNEE_NOT_MEMBER: '`assigneeId` is not a member of the project',
  INVALID_LABELS: 'a label does not exist in this project; details.missing names them',
  PRIMARY_NOT_MODULE: 'a label marked primary is not a module',
  MULTIPLE_PRIMARY: 'more than one label is marked primary',
  BODY_INVALID: 'the HTML description is empty once markup outside the allowlist is removed',
};

export const createIssueRoute = describeOperation({
  summary: 'File an issue in a project',
  description:
    'A `detectorKey` already held by an issue answers that issue with 200 and files nothing.',
  responses: {
    201: json(createdIssueSchema, 'The issue, with its attachments and relations'),
    200: json(dedupedIssueSchema, 'The detector key already stands for an issue'),
    400: fail({
      ...WRITE_REFUSALS,
      INVALID_STATUS: '`status` is not a status an issue may be filed at',
      INVALID_DETECTOR_KEY: '`detectorKey` is not a valid key',
      FILE_TOO_LARGE: 'an attachment is too large',
      PAYLOAD_TOO_LARGE: 'the attachments together are too large',
      EMPTY_FILE: 'an attachment is empty',
      INVALID_NAME: 'an attachment name is empty once cleaned',
      INVALID_BASE64: 'an attachment is not base64',
      MIME_NOT_ALLOWED: 'an attachment type is not allowed',
      ATTACHMENT_NAME_TAKEN: 'two attachments carry the same name',
      SELF_DEP: 'a relation names the issue itself',
      CROSS_PROJECT: 'a relation names an issue of another project',
      HOLD_NEEDS_BLOCKS: '`holdsUntil` was sent on an edge that is not `blocks`',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail(
      'NOT_FOUND',
      'the project does not exist, or a relation names an issue that does not',
    ),
    409: fail({
      CYCLE_DETECTED: 'a relation would close a loop of blocking issues',
      CYCLE_DEPTH_EXCEEDED: 'the blocking chain is too deep to check for a loop',
      ISSUE_ARCHIVED: 'a relation names an archived issue',
    }),
  },
});

export const listIssuesRoute = describeOperation({
  summary: "List a project's issues, a page at a time",
  description:
    'Archived issues are left out unless `includeArchived` is sent or `key` names one. `withAgentSessions` adds the live sessions of each row.',
  responses: {
    200: json(issueListSchema),
    400: fail({
      BAD_REQUEST: '`key` is not a display key this project can resolve',
      UNKNOWN_QUERY_PARAMETER:
        'a query parameter this route does not take; details lists the ones it does',
    }),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const readIssueByDisplay = describeOperation({
  summary: 'Read one issue by its display id, such as ISS-42',
  responses: {
    200: json(issueByDisplaySchema),
    400: fail('BAD_REQUEST', 'the display id does not name an issue key this project can hold'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project has no issue with this id'),
  },
});

export const readIssue = describeOperation({
  summary: 'Read one issue by uuid or display id',
  description:
    'A display id such as ISS-42 names an issue in one project only, so it needs `?projectId=`.',
  responses: { 200: json(issueDetailSchema), ...ISSUE_REF_REFUSALS },
});

export const readJobHistory = describeOperation({
  summary: "List an issue's jobs at one pipeline step, newest first, with their cost",
  responses: { 200: json(jobHistorySchema), 403: NOT_A_MEMBER, 404: NO_SUCH_ISSUE },
});

export const patchIssue = describeOperation({
  summary: 'Change fields of an issue',
  description:
    'Status moves go through `/transition`. `expect` is a precondition on `sessionContext`: send the value you read.',
  responses: {
    200: json(
      patchedIssueSchema,
      'The issue as stored; `warnings` says what the body sanitizer removed',
    ),
    400: fail({
      ...WRITE_REFUSALS,
      BRANCH_SELF_REFERENCE: "`baseBranch` names this issue's own branch",
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: NO_SUCH_ISSUE,
    409: fail({
      SESSION_CONTEXT_DROPS_UNREAD_KEYS:
        'the write would remove `sessionContext` keys it never read',
      SESSION_CONTEXT_MISMATCH: '`sessionContext` no longer holds the value `expect` named',
      LANDING_SHAPE_MARK_STANDS: '`landingShape` would change while a merge mark stands',
    }),
  },
});

export const deleteIssue = describeOperation({
  summary: 'Delete an issue',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: NO_SUCH_ISSUE,
  },
});
