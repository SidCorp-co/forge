// The issue routes under a project: create, look up by display id, and list.

import { Hono } from 'hono';
import { z } from 'zod';
import type { IssueStatus } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { createIssue } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { serializeIssue } from './detail-projection.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import { assertAssigneeIsMember, toHttpCreateError } from './issue-write-refusals.js';
import { listIssueLabels } from './label-service.js';
import { readLandingShape } from './landing-evidence.js';
import { serializeRestListRow } from './list-projection.js';
import { listIssues } from './list-service.js';
import { liveReachForIssue } from './live-reach-read.js';
import { pipelineHealthUnderived, safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { buildsWorkflowOf, fireOfCaller, proposesWorkflowOf, requirementOfIssue } from './ports.js';
import { findIssueByDisplaySeq, type IssueRow } from './read-service.js';
import { issueCreateSchema, issueFiltersSchema } from './request-schemas.js';
import { refuseLegacyStatusFields } from './status-input.js';

/** The one issue the detail page reads, whichever door it was resolved through. */
export async function issueDetailOf(issue: IssueRow) {
  const serialized = serializeIssue(
    issue,
    await activeIssuePrefix(issue.projectId),
    await readLandingShape(issue.projectId),
  );
  const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
  const creatorMap = await hydrateCreatorsForIssues([issue]);
  return {
    ...serialized,
    ...creatorMap.get(issue.id),
    pipelineHealth: healthMap.get(issue.id) ?? pipelineHealthUnderived(issue.status),
    liveReach: await liveReachForIssue(issue),
    buildsWorkflow: await buildsWorkflowOf(issue.id),
    proposesWorkflow: await proposesWorkflowOf(issue.id),
    requirement: await requirementOfIssue(issue.id),
    labels: await listIssueLabels(issue.id),
    comments: [],
    activity: [],
  };
}

export const issueProjectRoutes = new Hono<{ Variables: AuthVars }>();
issueProjectRoutes.use('*', requireAuth(), assertEmailVerified());

issueProjectRoutes.post(
  '/:id/issues',
  zValidator('param', idParamSchema),
  zValidator('json', issueCreateSchema),
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

const displayIdParamSchema = z.object({
  id: z.uuid(),
  displayId: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});

issueProjectRoutes.get(
  '/:id/issues/by-display/:displayId',
  zValidator('param', displayIdParamSchema),
  async (c) => {
    const { id: projectId, displayId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const parsed = parseIssueRef(
      displayId,
      issueRefNeedsHeldPrefixes(displayId) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest(parsed.message);
    const found = await findIssueByDisplaySeq(projectId, parsed.issSeq);
    if (!found) throw notFound('issue not found');
    const issue = await egressForRequest(restActor(c).agency, projectId, 'issue', found, displayId);

    return c.json(await issueDetailOf(issue));
  },
);

issueProjectRoutes.get(
  '/:id/issues',
  zValidator('param', idParamSchema),
  zValidator('query', issueFiltersSchema, (r) => {
    if (!r.success) {
      refuseLegacyStatusFields(r.data, 'query', ['status', 'statusNot']);
    }
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const listed = await listIssues(projectId, q, q);
    if (!listed.ok) {
      throw listed.field === 'key'
        ? badRequest(listed.message)
        : badRequest({ [listed.field]: listed.message });
    }
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
