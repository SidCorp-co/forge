/**
 * The REST issue routes' request schemas, split out of `routes.ts` on size grounds and re-exported
 * from it. Definitions only — nothing here reads a request or the database.
 */

import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { issueComplexities, issuePriorities, issueStatuses } from '../db/schema.js';
import { paginationSchema } from '../lib/pagination.js';
import { labelAttachItemSchema, workStatePatchSchema } from './input-schemas.js';
import { issueMetadataSchema } from './metadata.js';
import { ReleaseNotesSchema } from './release-notes.js';
import { sessionContextExpectSchema, sessionContextSchema } from './session-context.js';
import { issueSortValues } from './sort.js';

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
    workState: workStatePatchSchema.optional(),
    detectorKey: z.string().trim().min(1).max(120).optional(),
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
