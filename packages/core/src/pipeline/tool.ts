/**
 * ISS-145 — `forge_project_pipeline_runs`, one action-dispatching tool over
 * the five pipeline-run actions.
 *
 * Implementation lives in the per-action pure handlers exported by
 * `./tool-runs.ts`. This file owns input validation, required-field
 * checks per action, and routing. Authorization is re-applied inside each
 * handler — list gates on the projectId argument, the runId-resolved actions
 * gate after the run lookup, both through `requireCan(…, 'project.read', projectResource(…))` — so the
 * dispatcher does NOT collapse auth into a single pre-switch call.
 */

import { z } from 'zod';
import { pipelineRunStatuses } from '../db/schema.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { refusePipeline } from './refuse.js';
import {
  pipelineRunsCancelHandler,
  pipelineRunsGetHandler,
  pipelineRunsListHandler,
  pipelineRunsPauseHandler,
  pipelineRunsResumeHandler,
} from './tool-runs.js';

const argumentRequired = (field: 'runId' | 'projectId', action: string) =>
  refusePipeline('ARGUMENT_REQUIRED', `\`${field}\` is required for ${action}`, `/${field}`);

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'pause', 'resume', 'cancel']),

    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    runId: z.uuid().optional(),
    parkIssue: z.boolean().optional(),
  })
  .strict();

export const forgeProjectPipelineRunsTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_project_pipeline_runs',
  reach: 'project',
  route: '/api/pipeline-runs',
  grant: {
    byAction: {
      list: 'pipeline:read',
      get: 'pipeline:read',
      pause: 'pipeline:write',
      resume: 'pipeline:write',
      cancel: 'pipeline:write',
    },
  },
  description:
    'Lifecycle controls for project pipeline_runs. Actions: list | get | pause | resume | cancel. ' +
    'Every list row carries `liveJobs` — how many of its JOBS are still queued/dispatched/running. READ IT before treating `status` as liveness: a run stays `running` after its last job ends, so `status:"running"` with `liveJobs: 0` is usually a run nothing is working on, which filtering on status alone cannot tell apart. It is NOT proof of that: a resident master’s own run has no jobs row at all, so it reads 0 while fully live. Every row also carries `lane` — `job`, `run_session`, `master` or `system` — and `residentMaster`: on a `lane:"master"` row it is `{ sessionId, name, lastHeartbeatAt }` while that master’s session is live, and `null` once nothing holds the run, which is then an orphan like any other; off the master lane it is always `null`. Read `lane` and `residentMaster` before calling a run abandoned. ' +
    'list: requires projectId; optional issueId/status/limit filters; newest-first by started_at. ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'get/pause/resume/cancel: require runId. ' +
    'cancel parks the linked issue at `on_hold` by default, because every other status it could be left at is actionable and a master would take the issue up again on its next pass. Pass `parkIssue: false` for the other intent — "kill this run so a clean one starts" — and that pickup becomes the point. Cancelling returns `issueParked`, and `parkRefused` naming the refusal when the park was refused, so you can tell which happened. ' +
    'list answers the REST list (`GET /projects/:id/pipeline-runs`) rows plus `total`; get answers the REST run summary (`GET /pipeline-runs/:id`). ' +
    'Authorization: list scopes to project membership; get/pause/resume/cancel resolve the run first then enforce project membership; both additionally pass the token projectIds allowlist.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    switch (input.action) {
      case 'list': {
        if (!input.projectId) throw argumentRequired('projectId', 'list');
        return pipelineRunsListHandler(principal, {
          projectId: input.projectId,
          issueId: input.issueId,
          status: input.status,
          limit: input.limit,
        });
      }
      case 'get': {
        if (!input.runId) throw argumentRequired('runId', 'get');
        return pipelineRunsGetHandler(principal, { runId: input.runId });
      }
      case 'pause': {
        if (!input.runId) throw argumentRequired('runId', 'pause');
        return pipelineRunsPauseHandler(principal, { runId: input.runId });
      }
      case 'resume': {
        if (!input.runId) throw argumentRequired('runId', 'resume');
        return pipelineRunsResumeHandler(principal, { runId: input.runId });
      }
      case 'cancel': {
        if (!input.runId) throw argumentRequired('runId', 'cancel');
        return pipelineRunsCancelHandler(principal, {
          runId: input.runId,
          ...(input.parkIssue !== undefined ? { parkIssue: input.parkIssue } : {}),
        });
      }
    }
  },
});
