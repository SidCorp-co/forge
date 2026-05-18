/**
 * ISS-145 — Action-dispatcher consolidating the five
 * `forge_pipeline_runs.<action>` tools into a single `forge_project_pipeline_runs`
 * tool, mirroring the shape of `forge_issues` / `forge_comments`.
 *
 * Implementation lives in the per-action pure handlers exported by
 * `./forge-pipeline-runs.ts`. This file owns input validation, required-field
 * checks per action, and routing. Authorization is re-applied inside each
 * handler — list uses `assertDeviceOwnerIsMember`, the runId-resolved
 * actions use `assertPrincipalIsMember` (after the run lookup) — so the
 * dispatcher does NOT collapse auth into a single pre-switch call.
 */

import { z } from 'zod';
import { pipelineRunStatuses } from '../../db/schema.js';
import {
  pipelineRunsCancelHandler,
  pipelineRunsGetHandler,
  pipelineRunsListHandler,
  pipelineRunsPauseHandler,
  pipelineRunsResumeHandler,
} from './forge-pipeline-runs.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'pause', 'resume', 'cancel']),
    // list args
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    // get/pause/resume/cancel args
    runId: z.uuid().optional(),
  })
  .strict();

export const forgeProjectPipelineRunsTool: ContextScopedMcpToolFactory = ({
  device,
  principal,
}) => ({
  name: 'forge_project_pipeline_runs',
  description:
    'Lifecycle controls for project pipeline_runs. Actions: list | get | pause | resume | cancel. ' +
    'list: requires projectId; optional issueId/status/limit filters; newest-first by started_at. ' +
    'get/pause/resume/cancel: require runId. ' +
    'Authorization: list scopes to the device owner being a project member; get/pause/resume/cancel resolve the run first then enforce project membership (PAT principals additionally pass the projectIds allowlist).',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    switch (input.action) {
      case 'list': {
        if (!input.projectId) {
          throw new Error('BAD_REQUEST: projectId is required for list');
        }
        return pipelineRunsListHandler(device, {
          projectId: input.projectId,
          issueId: input.issueId,
          status: input.status,
          limit: input.limit,
        });
      }
      case 'get': {
        if (!input.runId) throw new Error('BAD_REQUEST: runId is required for get');
        return pipelineRunsGetHandler(principal, { runId: input.runId });
      }
      case 'pause': {
        if (!input.runId) throw new Error('BAD_REQUEST: runId is required for pause');
        return pipelineRunsPauseHandler(principal, { runId: input.runId });
      }
      case 'resume': {
        if (!input.runId) throw new Error('BAD_REQUEST: runId is required for resume');
        return pipelineRunsResumeHandler(principal, { runId: input.runId });
      }
      case 'cancel': {
        if (!input.runId) throw new Error('BAD_REQUEST: runId is required for cancel');
        return pipelineRunsCancelHandler(principal, { runId: input.runId });
      }
    }
  },
});
