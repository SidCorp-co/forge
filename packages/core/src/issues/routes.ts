import type { IssueUpdateField } from '@forge/contracts/issue-vocabulary';
import { redactedMessage } from '@forge/observability';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { BodyInvalidError } from '../body/errors.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { db } from '../db/client.js';
import { issues, jobTypes, projectMembers } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { listResponse } from '../lib/pagination.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { logger } from '../logger.js';
import { deleteMemory } from '../memory/indexer.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
  restCredential,
} from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { collectWorkEvidence } from '../pipeline/work-evidence.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { issueArchiveSide } from './archive.js';
import { AttachmentError } from './attachment-service.js';
import { registerIssueAttributeRoutes } from './attributes/routes.js';
import { archivedProjectRefusal, createIssue, IssueCreateError } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { toHttpDependencyError } from './dependency-routes.js';
import { IssueDependencyError } from './dependency-service.js';
import { serializeIssue } from './detail-projection.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import {
  LabelResolutionError,
  listIssueLabels,
  PrimaryModuleError,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { readLandingShape } from './landing-evidence.js';
import { issueListPageQuery, serializeRestListRow } from './list-projection.js';
import { liveReachForIssue } from './live-reach-read.js';
import { observedMergeForIssue } from './merge-record.js';
import { isSelfReferentialBranch } from './metadata.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { pipelineHealthUnderived, safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { findIssueByDisplaySeq, findIssueById, type IssueRow } from './read-service.js';
import {
  createdIssueSchema,
  createIssueRoute,
  dedupedIssueSchema,
  deleteIssue,
  issueByDisplaySchema,
  issueCreateSchema,
  issueDetailSchema,
  issueFiltersSchema,
  issueListSchema,
  issuePatchSchema,
  jobHistorySchema,
  listIssuesRoute,
  patchedIssueSchema,
  patchIssue,
  readIssue,
  readIssueByDisplay,
  readJobHistory,
  STATUS_IS_NOT_AN_UPDATE,
} from './routes-reference.js';
import { jobHistoryForStep } from './search.js';
import { buildIssueOrderBy } from './sort.js';
import { toHttpUpdateError } from './update-http-errors.js';
import { IssueUpdateNotFound, updateIssueFields } from './update-service.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';
export {
  type IssueCreateInput,
  type IssueFilters,
  type IssuePatchInput,
  issueCreateSchema,
  issueFiltersSchema,
  issuePatchSchema,
} from './routes-reference.js';

import { withKernelMarker } from '../db/kernel-marker.js';

const projectIdParamSchema = z.object({ id: z.uuid() });
const issueIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown, message = 'Invalid input') =>
  new HTTPException(400, { message, cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

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
  createIssueRoute,
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

    const credential = restCredential(c);
    let result: Awaited<ReturnType<typeof createIssue>>;
    try {
      result = await createIssue(
        { ...input, projectId },
        {
          createdById: userId,
          createdVia: credential.via,
          createdViaTokenId: credential.tokenId,
          actor: restActor(c),
        },
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }

    if (result.deduped) return c.json(answer(dedupedIssueSchema, result), 200);

    const response = {
      ...serializeIssue(
        result.issue as IssueRow,
        await activeIssuePrefix(projectId),
        await readLandingShape(db, projectId),
      ),
      attachments: result.attachments,
      ...(result.attachmentErrors.length > 0 ? { attachmentErrors: result.attachmentErrors } : {}),
      ...(result.relations.length > 0 ? { relations: result.relations } : {}),
      ...(result.bodyWarnings.length > 0 ? { warnings: result.bodyWarnings } : {}),
    };
    return c.json(answer(createdIssueSchema, response), 201);
  },
);

function toHttpCreateError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  if (err instanceof IssueDependencyError) return toHttpDependencyError(err);
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
    if (code === 'PROJECT_ARCHIVED') {
      return new HTTPException(409, {
        message: archivedProjectRefusal(err.value),
        cause: { code },
      });
    }
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
  readIssueByDisplay,
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

    const serialized = serializeIssue(
      issue,
      await activeIssuePrefix(projectId),
      await readLandingShape(db, projectId),
    );
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, [issue.id]);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById },
    ]);
    return c.json(
      answer(issueByDisplaySchema, {
        ...serialized,
        ...creatorMap.get(issue.id),
        pipelineHealth: healthMap.get(issue.id) ?? pipelineHealthUnderived(serialized.status),
        liveReach: await liveReachForIssue(issue),
        recordedBranch: (await collectWorkEvidence(issue.id)).branch,
        newestMergedPull: (await observedMergeForIssue(db, issue.id))?.commitSha ?? null,
        labels: labelRows,
        comments: [],
        activity: [],
      }),
    );
  },
);

issueProjectRoutes.get(
  '/:id/issues',
  listIssuesRoute,
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
    conditions.push(...issueArchiveSide(q.includeArchived === true || q.key !== undefined));
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
      return c.json(answer(issueListSchema, listResponse(c, [], total, q)));
    }

    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, ids);
    const creatorMap = await hydrateCreatorsForIssues(
      serialized.map((r) => ({ id: r.id, createdById: r.createdById })),
    );

    if (!q.withAgentSessions) {
      return c.json(
        answer(
          issueListSchema,
          listResponse(
            c,
            serialized.map((r) => ({
              ...r,
              ...creatorMap.get(r.id),
              pipelineHealth: healthMap.get(r.id) ?? pipelineHealthUnderived(r.status),
            })),
            total,
            q,
          ),
        ),
      );
    }

    const map = await hydrateAgentSessionsForIssues(projectId, ids);
    return c.json(
      answer(
        issueListSchema,
        listResponse(
          c,
          serialized.map((r) => {
            const bucket = map.get(r.id);
            return {
              ...r,
              ...creatorMap.get(r.id),
              agentSessions: bucket?.agentSessions ?? [],
              agentStatus: bucket?.agentStatus ?? null,
              pipelineHealth: healthMap.get(r.id) ?? pipelineHealthUnderived(r.status),
            };
          }),
          total,
          q,
        ),
      ),
    );
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);
registerIssueAttributeRoutes(issueRoutes);

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  readIssue,
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const id = issue.id;

    const labelRows = await listIssueLabels(id);

    const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
    const serialized = serializeIssue(
      issue,
      await activeIssuePrefix(issue.projectId),
      await readLandingShape(db, issue.projectId),
    );
    const agentMap = await hydrateAgentSessionsForIssues(issue.projectId, [issue.id]);
    const agentBucket = agentMap.get(issue.id);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById },
    ]);
    return c.json(
      answer(issueDetailSchema, {
        ...serialized,
        ...creatorMap.get(issue.id),
        agentSessions: agentBucket?.agentSessions ?? [],
        agentStatus: agentBucket?.agentStatus ?? null,
        pipelineHealth: healthMap.get(issue.id) ?? pipelineHealthUnderived(serialized.status),
        liveReach: await liveReachForIssue(issue),
        recordedBranch: (await collectWorkEvidence(issue.id)).branch,
        newestMergedPull: (await observedMergeForIssue(db, issue.id))?.commitSha ?? null,
        labels: labelRows,
        comments: [],
        activity: [],
      }),
    );
  },
);

const jobHistoryQuerySchema = z.object({
  step: z.enum(jobTypes),
});

issueRoutes.get(
  '/:id/job-history',
  readJobHistory,
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

    return c.json(answer(jobHistorySchema, await jobHistoryForStep(id, step)));
  },
);

issueRoutes.patch(
  '/:id',
  patchIssue,
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issuePatchSchema, (r) => {
    if (!r.success) {
      // A sent `status` is said in the message itself, not only in the details (ISS-1421 r2).
      const status = r.error.issues.some((i) => i.message === STATUS_IS_NOT_AN_UPDATE);
      throw badRequest(z.flattenError(r.error), status ? STATUS_IS_NOT_AN_UPDATE : undefined);
    }
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
    const changedFields: IssueUpdateField[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (field: IssueUpdateField & keyof IssueRow, next: unknown) => {
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
        (f, v) => track(f as IssueUpdateField & keyof IssueRow, v),
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
      throw toHttpUpdateError(err);
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

    const patched = serializeIssue(
      updated,
      await activeIssuePrefix(issue.projectId),
      await readLandingShape(db, issue.projectId),
    );
    return c.json(
      answer(
        patchedIssueSchema,
        collected.warnings.length > 0 ? { ...patched, warnings: collected.warnings } : patched,
      ),
    );
  },
);

issueRoutes.delete(
  '/:id',
  deleteIssue,
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
          { err: redactedMessage(err), issueId: id, projectId: issue.projectId },
          'issues.delete: memory cleanup failed',
        );
      });
    });

    return c.body(null, 204);
  },
);
