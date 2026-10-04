import { diffFieldValue } from '@forge/contracts/field-changes';
import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import { Hono } from 'hono';
import { z } from 'zod';
import { fireOfCaller, issueDeleteRefusal } from '../agent-reports/service.js';
import { BodyInvalidError } from '../body/errors.js';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { type IssueStatus, issueComplexities, issuePriorities, jobTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { listResponse } from '../lib/pagination.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { refusalEnvelope, refuser } from '../lib/refusal.js';
import { logger } from '../logger.js';
import { deleteMemory } from '../memory/indexer.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requirementOfIssue } from '../requirements/issue-links.js';
import { proposesWorkflowOf } from '../workflows/design-issue.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { registerIssueAttributeRoutes } from './attributes/routes.js';
import { heldTakeRefusal } from './blocked-by.js';
import { CREATE_ENTRY_STATUSES, createIssue } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { serializeIssue } from './detail-projection.js';
import { dispatchGatesOf } from './dispatch-gates.js';
import { attachmentInputSchema, labelAttachItemSchema } from './input-schemas.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import {
  listIssueLabels,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { readLandingShape } from './landing-evidence.js';
import { serializeRestListRow } from './list-projection.js';
import { listIssues } from './list-service.js';
import { liveReachForIssue } from './live-reach-read.js';
import { isSelfReferentialBranch } from './metadata.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { pipelineHealthUnderived, safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import {
  findIssueByDisplaySeq,
  findIssueById,
  type IssueRow,
  isProjectMember,
  jobHistoryForStep,
} from './read-service.js';
import { issueRelationInputSchema } from './relations-service.js';
import { issueFiltersSchema, issuePatchSchema } from './request-schemas.js';
import { refuseLegacyStatusFields } from './status-input.js';
import { deleteIssue } from './service.js';
import { updateIssueFields } from './update-service.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { badRequest, notFound } from '../middleware/route-errors.js';
import { requireHeld } from '../permissions/index.js';

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

export {
  type IssueFilters,
  type IssuePatchInput,
  issueFiltersSchema,
  issuePatchSchema,
} from './request-schemas.js';

const projectIdParamSchema = z.object({ id: z.uuid() });
const issueIdParamSchema = z.object({ id: z.uuid() });

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  if (!(await isProjectMember(projectId, assigneeId))) {
    throw refuseUpdate(
      'ASSIGNEE_NOT_MEMBER',
      'the assignee is not a member of this project; assign someone who is',
      '/assigneeId',
    );
  }
}

export { bodyRoutes } from '../body/routes.js';

const refuseUpdate = refuser<IssueUpdateRefusalCode>('ISSUE_UPDATE_REFUSED');

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
    requireHeld(access, 'project.write');

    if (input.assigneeId) await assertAssigneeIsMember(projectId, input.assigneeId);

    const deviceId = c.get('patDeviceId') ?? null;
    let result: Awaited<ReturnType<typeof createIssue>>;
    try {
      result = await createIssue(
        { ...input, projectId },
        {
          createdById: userId,
          createdByDeviceId: deviceId,
          createdVia: 'web',
          actor: restActor(c),
          scheduleRunId: deviceId
            ? await fireOfCaller({ deviceId, boundProjectId: projectId })
            : null,
        },
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }

    if (result.deduped) return c.json(result, 200);

    const response: Record<string, unknown> = serializeIssue(
      result.issue as IssueRow,
      await activeIssuePrefix(projectId),
      await readLandingShape(projectId),
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
  return heldTakeRefusal(err) ?? err;
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
    requireHeld(access, 'project.read');

    const parsed = parseIssueRef(
      displayId,
      issueRefNeedsHeldPrefixes(displayId) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
    const found = await findIssueByDisplaySeq(projectId, parsed.issSeq);
    if (!found) throw notFound('issue not found');
    const issue = await egressForRequest(restActor(c).agency, projectId, 'issue', found, displayId);

    const labelRows = await listIssueLabels(issue.id);

    const serialized = serializeIssue(
      issue,
      await activeIssuePrefix(projectId),
      await readLandingShape(projectId),
    );
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, [issue.id]);
    const creatorMap = await hydrateCreatorsForIssues([issue]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      pipelineHealth: healthMap.get(issue.id) ?? pipelineHealthUnderived(issue.status),
      liveReach: await liveReachForIssue(issue),
      ...(await dispatchGatesOf(issue.id, issue.projectId)),
      proposesWorkflow: await proposesWorkflowOf(issue.id),
      requirement: await requirementOfIssue(issue.id),
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
    if (!r.success) {
      refuseLegacyStatusFields(r.data, 'query', ['status', 'statusNot']);
      throw queryBadRequest(issueFiltersSchema, r.error);
    }
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const listed = await listIssues(projectId, q, q);
    if (!listed.ok) throw badRequest({ formErrors: [listed.message], fieldErrors: {} });
    const rows = await egressForRequest(
      restActor(c).agency,
      projectId,
      'issue',
      listed.rows,
      'the issue list',
    );
    const total = listed.total;

    const listPrefix = await activeIssuePrefix(projectId);
    const serialized = rows.map((r) => serializeRestListRow(r, listPrefix));
    if (serialized.length === 0) {
      return c.json(listResponse(c, serialized, total, q));
    }

    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, ids);
    const creatorMap = await hydrateCreatorsForIssues(serialized);

    if (!q.withAgentSessions) {
      return c.json(
        listResponse(
          c,
          serialized.map((r) => ({
            ...r,
            ...creatorMap.get(r.id),
            pipelineHealth: healthMap.get(r.id) ?? pipelineHealthUnderived(r.status as IssueStatus),
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
            pipelineHealth: healthMap.get(r.id) ?? pipelineHealthUnderived(r.status as IssueStatus),
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
registerIssueAttributeRoutes(issueRoutes);

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
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

    const resolved = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issue = await egressForRequest(
      restActor(c).agency,
      resolved.projectId,
      'issue',
      resolved,
      rawId,
    );
    const id = issue.id;

    const labelRows = await listIssueLabels(id);

    const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
    const serialized = serializeIssue(
      issue,
      await activeIssuePrefix(issue.projectId),
      await readLandingShape(issue.projectId),
    );
    const agentMap = await hydrateAgentSessionsForIssues(issue.projectId, [issue.id]);
    const agentBucket = agentMap.get(issue.id);
    const creatorMap = await hydrateCreatorsForIssues([issue]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      agentSessions: agentBucket?.agentSessions ?? [],
      agentStatus: agentBucket?.agentStatus ?? null,
      pipelineHealth: healthMap.get(issue.id) ?? pipelineHealthUnderived(issue.status),
      liveReach: await liveReachForIssue(issue),
      ...(await dispatchGatesOf(issue.id, issue.projectId)),
      proposesWorkflow: await proposesWorkflowOf(issue.id),
      requirement: await requirementOfIssue(issue.id),
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
    requireHeld(access, 'project.read');

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
    requireHeld(access, 'project.write');

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
      if (diffFieldValue(field, prev, next).length > 0) {
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
        throw refuseUpdate(
          'BRANCH_SELF_REFERENCE',
          "baseBranch must not reference this issue's own branch; name the branch this work is based on",
          '/metadata/branchConfig/baseBranch',
        );
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
        ...(patch.workState ? { workState: patch.workState } : {}),
        actor,
        changes: { fields: changedFields, before, after },
      });
    } catch (err) {
      throw heldTakeRefusal(err) ?? err;
    }

    const patched = serializeIssue(
      updated,
      await activeIssuePrefix(issue.projectId),
      await readLandingShape(issue.projectId),
    );
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
    requireHeld(access, 'project.admin');

    const carried = await issueDeleteRefusal(issue);
    if (carried) return c.json(refusalEnvelope([carried], carried.code), 422);

    await deleteIssue(id);

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
