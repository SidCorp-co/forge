import { diffFieldValue } from '@forge/contracts/field-changes';
import { Hono } from 'hono';
import { z } from 'zod';
import { jobTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { registerIssueAttributeRoutes } from './attributes/routes.js';
import { heldTakeRefusal } from './blocked-by.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { serializeIssue } from './detail-projection.js';
import { dispatchGatesOf } from './dispatch-gates.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import { assertAssigneeIsMember, refuseUpdate, toHttpCreateError } from './issue-write-refusals.js';
import {
  listIssueLabels,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { readLandingShape } from './landing-evidence.js';
import { liveReachForIssue } from './live-reach-read.js';
import { isSelfReferentialBranch } from './metadata.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { pipelineHealthUnderived, safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { findIssueById, type IssueRow, jobHistoryForStep } from './read-service.js';
import { issuePatchSchema } from './request-schemas.js';
import { deleteIssue } from './service.js';
import { updateIssueFields } from './update-service.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { requireHeld } from '../permissions/index.js';
import {
  deleteMemory,
  issueDeleteRefusal,
  proposesWorkflowOf,
  requirementOfIssue,
} from './ports.js';

export { bodyRoutes } from '../body/routes.js';

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueAttributeRoutes(issueRoutes);

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
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
      ...(await dispatchGatesOf(issue.id)),
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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', jobHistoryQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', issuePatchSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.admin');

    const carried = await issueDeleteRefusal(issue);
    if (carried) return refused(c, [carried], carried.code);

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

export { issueActivityRoutes, projectActivityRoutes } from './activity-routes.js';
export { issueArchiveRoutes } from './archive-routes.js';
export { attachmentRoutes, issueAttachmentRoutes } from './attachment-routes.js';
export { backlogStreamRoutes } from './backlog/routes.js';
export { issueCriteriaRoutes } from './criteria/routes.js';
export { issueDependencyRoutes } from './dependency-routes.js';
export { issueExtrasRoutes } from './extras-routes.js';
export { issueGraphRoutes } from './graph-routes.js';
export { issueMergeRoutes } from './merge-routes.js';
export { issueProjectRoutes } from './project-issue-routes.js';
export { searchRoutes } from './search.js';
export { issueStandingRoutes } from './standing-routes.js';
export { issueSteerRoutes } from './steer-routes.js';
export { transitionRoutes } from './transition.js';
