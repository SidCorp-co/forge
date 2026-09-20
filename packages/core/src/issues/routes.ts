import { zValidator } from '@hono/zod-validator';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { BodyInvalidError } from '../body/errors.js';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { db } from '../db/client.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  issues,
  jobTypes,
  projectMembers,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { logger } from '../logger.js';
import { deleteMemory } from '../memory/indexer.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { AttachmentError } from './attachment-service.js';
import { CREATE_ENTRY_STATUSES, createIssue, IssueCreateError } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import {
  LabelResolutionError,
  listIssueLabels,
  PrimaryModuleError,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { issueListPageQuery, serializeRestListRow } from './list-projection.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { findIssueByDisplaySeq, findIssueById, type IssueRow } from './read-service.js';
import { issueRelationInputSchema } from './relations-service.js';
import { jobHistoryForStep } from './search.js';
import { sessionContextExpectSchema, sessionContextSchema } from './session-context.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';
import {
  IssueUpdateNotFound,
  SessionContextExpectMismatch,
  updateIssueFields,
} from './update-service.js';

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

import { isSelfReferentialBranch, issueMetadataSchema } from './metadata.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { withKernelMarker } from '../db/kernel-marker.js';
import { ReleaseNotesSchema } from './release-notes.js';

const labelAttachItemSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      labelId: z.string().trim().min(1),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
]);

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
  })
  .strict();

export type IssueFilters = z.infer<typeof issueFiltersSchema>;

const projectIdParamSchema = z.object({ id: z.uuid() });
const issueIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const sessionContextMoved = (err: SessionContextExpectMismatch) =>
  new HTTPException(409, {
    message:
      '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
      'Re-read it from `details.current`, decide whether your claim still stands, and send the write again with the new `expect`.',
    cause: { code: 'SESSION_CONTEXT_MISMATCH', details: { current: err.current } },
  });

interface IssueBodyColumns {
  description?: string | null;
  descriptionFormat?: string | null;
}

function serializeIssue<T extends { issSeq: number } & IssueBodyColumns>(
  row: T,
  prefix: string | null,
): T & { displayId: string; descriptionNodes: BodyNode[] | null } {
  return {
    ...row,
    displayId: formatIssueRef(prefix, row.issSeq),
    descriptionNodes: bodyNodes(row.description ?? '', row.descriptionFormat),
  };
}

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, assigneeId)))
    .limit(1);
  if (!row) {
    throw new HTTPException(400, {
      message: 'assignee must be a project member',
      cause: { code: 'ASSIGNEE_NOT_MEMBER' },
    });
  }
}

export { bodyRoutes } from '../body/routes.js';

export const issueProjectRoutes = new Hono<{ Variables: AuthVars }>();
issueProjectRoutes.use('*', requireAuth(), assertEmailVerified());

issueProjectRoutes.post(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issueCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member');

    if (input.assigneeId) await assertAssigneeIsMember(projectId, input.assigneeId);

    let result: Awaited<ReturnType<typeof createIssue>>;
    try {
      result = await createIssue(
        { ...input, projectId },
        { createdById: userId, createdVia: 'web', actor: restActor(c) },
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }

    if (result.deduped) return c.json(result, 200);

    const response: Record<string, unknown> = serializeIssue(
      result.issue as IssueRow,
      await activeIssuePrefix(projectId),
    );
    response.attachments = result.attachments;
    if (result.attachmentErrors.length > 0) response.attachmentErrors = result.attachmentErrors;
    if (result.relations.length > 0) response.relations = result.relations;
    if (result.bodyWarnings.length > 0) response.warnings = result.bodyWarnings;
    return c.json(response, 201);
  },
);

function toHttpCreateError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  if (err instanceof LabelResolutionError) {
    return new HTTPException(400, {
      message: 'one or more labels do not exist in this project',
      cause: { code: 'INVALID_LABELS', details: { missing: err.missing } },
    });
  }
  if (err instanceof PrimaryModuleError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof AttachmentError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof IssueCreateError) {
    const code = err.code;
    return new HTTPException(400, { message: `${code}: ${err.value}`, cause: { code } });
  }
  return err;
}

const displayIdParamSchema = z.object({
  id: z.uuid(),
  displayId: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});

issueProjectRoutes.get(
  '/:id/issues/by-display/:displayId',
  zValidator('param', displayIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId, displayId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const parsed = parseIssueRef(
      displayId,
      issueRefNeedsHeldPrefixes(displayId) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
    const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
    if (!issue) throw notFound('issue not found');

    const labelRows = await listIssueLabels(issue.id);

    const serialized = serializeIssue(issue, await activeIssuePrefix(projectId));
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, [issue.id]);
    const creatorMap = await hydrateCreatorsForIssues([
      {
        id: issue.id,
        createdById: issue.createdById,
        createdVia: issue.createdVia,
        creatorAgency: issue.creatorAgency,
      },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

issueProjectRoutes.get(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', issueFiltersSchema, (r) => {
    if (!r.success) throw queryBadRequest(issueFiltersSchema, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conditions = [eq(issues.projectId, projectId)];
    if (q.status) conditions.push(eq(issues.status, q.status));
    if (q.priority) conditions.push(eq(issues.priority, q.priority));
    if (q.assigneeId) conditions.push(eq(issues.assigneeId, q.assigneeId));
    if (q.category) conditions.push(eq(issues.category, q.category));
    if (q.key !== undefined) {
      const parsed = parseIssueRef(
        q.key,
        issueRefNeedsHeldPrefixes(q.key) ? await heldIssuePrefixes(projectId) : [],
      );
      if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
      conditions.push(eq(issues.issSeq, parsed.issSeq));
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const rows = await issueListPageQuery({
      where,
      orderBy: buildIssueOrderBy(q.sort),
      limit: q.limit,
      offset: q.offset,
    });

    const total = Number(n);

    const listPrefix = await activeIssuePrefix(projectId);
    const serialized = rows.map((r) => serializeRestListRow(r, listPrefix));
    if (serialized.length === 0) {
      return c.json(listResponse(c, serialized, total, q));
    }

    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, ids);
    const creatorMap = await hydrateCreatorsForIssues(
      serialized.map((r) => ({
        id: r.id,
        createdById: r.createdById,
        createdVia: r.createdVia,
        creatorAgency: r.creatorAgency,
      })),
    );

    if (!q.withAgentSessions) {
      return c.json(
        listResponse(
          c,
          serialized.map((r) => ({
            ...r,
            ...creatorMap.get(r.id),
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          })),
          total,
          q,
        ),
      );
    }

    const map = await hydrateAgentSessionsForIssues(projectId, ids);
    return c.json(
      listResponse(
        c,
        serialized.map((r) => {
          const bucket = map.get(r.id);
          return {
            ...r,
            ...creatorMap.get(r.id),
            agentSessions: bucket?.agentSessions ?? [],
            agentStatus: bucket?.agentStatus ?? null,
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          };
        }),
        total,
        q,
      ),
    );
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const labelRows = await listIssueLabels(id);

    const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
    const serialized = serializeIssue(issue, await activeIssuePrefix(issue.projectId));
    const agentMap = await hydrateAgentSessionsForIssues(issue.projectId, [issue.id]);
    const agentBucket = agentMap.get(issue.id);
    const creatorMap = await hydrateCreatorsForIssues([
      {
        id: issue.id,
        createdById: issue.createdById,
        createdVia: issue.createdVia,
        creatorAgency: issue.creatorAgency,
      },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      agentSessions: agentBucket?.agentSessions ?? [],
      agentStatus: agentBucket?.agentStatus ?? null,
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

const jobHistoryQuerySchema = z.object({
  step: z.enum(jobTypes),
});

issueRoutes.get(
  '/:id/job-history',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', jobHistoryQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { step } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    return c.json(await jobHistoryForStep(id, step));
  },
);

issueRoutes.patch(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issuePatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    if (patch.assigneeId) await assertAssigneeIsMember(issue.projectId, patch.assigneeId);
    let resolvedLabelIds: ResolvedLabelAttach[] | undefined;
    if (patch.labels !== undefined) {
      try {
        resolvedLabelIds = await resolveLabelIdsForWrite(issue.projectId, patch.labels);
      } catch (err) {
        throw toHttpCreateError(err);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const changedFields: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (field: keyof IssueRow, next: unknown) => {
      const prev = issue[field];
      if (prev !== next) {
        changedFields.push(field);
        before[field] = prev;
        after[field] = next;
      }
    };
    let collected: ReturnType<typeof collectIssueFieldUpdates>;
    try {
      collected = collectIssueFieldUpdates(
        patch,
        [...SHARED_ISSUE_PATCH_FIELDS, 'assigneeId'],
        (f, v) => track(f as keyof IssueRow, v),
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }
    Object.assign(updates, collected.updates);
    if (patch.metadata !== undefined) {
      const baseRaw = patch.metadata?.branchConfig?.baseBranch;
      if (typeof baseRaw === 'string' && isSelfReferentialBranch(baseRaw, issue.issSeq)) {
        throw new HTTPException(400, {
          message: "baseBranch must not reference this issue's own branch",
          cause: { code: 'BRANCH_SELF_REFERENCE' },
        });
      }
      updates.metadata = patch.metadata;
      track('metadata', patch.metadata);
    }

    const actor = restActor(c);

    let updated: IssueRow;
    try {
      updated = await updateIssueFields({
        issueId: id,
        updates,
        labelIds: resolvedLabelIds,
        ...(patch.expect ? { expect: patch.expect } : {}),
        actor,
      });
    } catch (err) {
      if (err instanceof IssueUpdateNotFound) throw notFound('issue not found');
      if (err instanceof SessionContextExpectMismatch) throw sessionContextMoved(err);
      throw err;
    }

    if (changedFields.length > 0) {
      await hooks.emit('issueUpdated', {
        issueId: id,
        projectId: issue.projectId,
        actor,
        fields: changedFields,
        before,
        after,
      });
    }

    const patched = serializeIssue(updated, await activeIssuePrefix(issue.projectId));
    return c.json(
      collected.warnings.length > 0 ? { ...patched, warnings: collected.warnings } : patched,
    );
  },
);

issueRoutes.delete(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    await withKernelMarker(db, async (tx) => tx.delete(issues).where(eq(issues.id, id)));

    queueMicrotask(() => {
      deleteMemory(issue.projectId, 'issue', id).catch((err) => {
        logger.warn(
          { err: (err as Error).message, issueId: id, projectId: issue.projectId },
          'issues.delete: memory cleanup failed',
        );
      });
    });

    return c.body(null, 204);
  },
);
