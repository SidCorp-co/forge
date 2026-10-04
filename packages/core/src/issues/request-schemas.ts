/**
 * The REST issue routes' request schemas, kept apart from `routes.ts` so the module's light face
 * can export them without building a router. Definitions only — nothing here reads a request or
 * the database.
 */

import { ReleaseNotesSchema } from '@forge/contracts/release-notes';
import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { issueComplexities, issuePriorities, issueStatuses } from '../db/schema.js';
import { paginationSchema } from '../lib/pagination.js';
import { ISSUE_INITIAL_STATUSES as CREATE_ENTRY_STATUSES } from '@forge/contracts/issue-machine';
import {
  attachmentInputSchema,
  labelAttachItemSchema,
  workStatePatchSchema,
} from './input-schemas.js';
import { issueMetadataSchema } from './metadata.js';
import { issueRelationInputSchema } from './relations-service.js';
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

const oneOrMany = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

const instantSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((v) => new Date(v));

/** The issue-list filters `issues/list-service.ts:listIssues` reads, as both REST lists take them. */
export const issueListFilterFields = {
  status: oneOrMany(z.enum(issueStatuses)),
  statusNot: oneOrMany(z.enum(issueStatuses)),
  priority: oneOrMany(z.enum(issuePriorities)),
  category: z.string().trim().min(1).max(100).optional(),
  complexity: z.enum(issueComplexities).optional(),
  createdAfter: instantSchema.optional(),
  createdBefore: instantSchema.optional(),
  updatedAfter: instantSchema.optional(),
  createdBy: z.union([z.uuid(), z.literal('agent')]).optional(),
  origin: z.enum(['detector', 'human']).optional(),
  /** ISS-1257 — widen `status` to also match an issue a person owes an answer, whatever its status. */
  orWaitingOnPerson: z.stringbool().optional(),
  key: issueKeyFilterSchema.optional(),
  label: oneOrMany(z.string().trim().min(1)),
  module: oneOrMany(z.string().trim().min(1)),
  sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
  withAgentSessions: z.coerce.boolean().optional().default(false),
  /** ISS-1237 — archived issues are left out unless asked for; a `key` is retrieval and always answers. */
  includeArchived: z.stringbool().optional(),
};

export const issueFiltersSchema = paginationSchema
  .extend({
    ...issueListFilterFields,
    assigneeId: z.uuid().optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type IssueFilters = z.infer<typeof issueFiltersSchema>;

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
