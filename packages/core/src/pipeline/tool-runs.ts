/**
 * The pipeline-run actions `forge_project_pipeline_runs` dispatches into. List
 * and get read through the REST door's readers; pause, resume and cancel call
 * the same controls the REST routes do.
 */

import { z } from 'zod';
import { pipelineRunStatuses } from '../db/schema.js';
import { principalAgency } from '../issues/index.js';
import { buildListEnvelope, overfetch } from '../lib/list-envelope.js';
import { patEffectiveProjectIds, principalUserId } from '../lib/tool.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { listProjectPipelineRuns } from './read.js';
import { refusePipeline } from './refuse.js';
import { readPipelineRun } from './runs.js';
import { cancelPipelineRun, pausePipelineRun, resumePipelineRun } from './runs-control.js';
import { loadPipelineRunSummary } from './runs-rollup.js';

const pipelineRunsListInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const pipelineRunsRunIdInputSchema = z.object({ runId: z.uuid() }).strict();

const pipelineRunsCancelInputSchema = z
  .object({ runId: z.uuid(), parkIssue: z.boolean().optional() })
  .strict();

const runNotFound = (runId: string) =>
  refusePipeline('PIPELINE_RUN_NOT_FOUND', `pipeline run ${runId} was not found`, '/runId');

// a chat turn runs this tool in process, outside the pat scope REST and /mcp enter, so the role check alone would reach a run of any project the asker belongs to: the token's own fence is read here, and a project it does not reach is not found, as at the other doors
const outsideFence = (principal: McpPrincipal, projectId: string): boolean => {
  const fence = patEffectiveProjectIds(principal);
  return fence !== null && !fence.includes(projectId);
};

async function loadRunForPrincipal(principal: McpPrincipal, runId: string) {
  const row = await readPipelineRun(runId);
  if (!row || outsideFence(principal, row.projectId)) throw runNotFound(runId);
  await requireCan(actorFor(principal.userId), 'project.read', projectResource(row.projectId));
  return row;
}

/** The REST list's own reader, so the two doors cannot disagree about a run. */
export async function pipelineRunsListHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsListInputSchema>,
) {
  if (outsideFence(principal, input.projectId)) throw notFound();
  await requireCan(actorFor(principal.userId), 'project.read', projectResource(input.projectId));

  const runsLimit = input.limit ?? 50;
  const { items, total } = await listProjectPipelineRuns(input.projectId, {
    status: input.status,
    issueId: input.issueId,
    limit: overfetch(runsLimit),
    offset: 0,
  });

  return {
    ...buildListEnvelope({
      key: 'runs',
      items,
      limit: runsLimit,
      hint: 'narrow with status/issueId filters',
    }),
    total,
  };
}

/** The REST run summary (`GET /pipeline-runs/:id`). */
export async function pipelineRunsGetHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  await loadRunForPrincipal(principal, input.runId);
  const summary = await loadPipelineRunSummary(input.runId);
  if (!summary) throw runNotFound(input.runId);
  return summary;
}

export async function pipelineRunsPauseHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await requireCan(actorFor(principal.userId), 'project.write', projectResource(loaded.projectId));
  const run = await pausePipelineRun(input.runId, {
    type: 'user',
    id: principalUserId(principal),
    agency: principalAgency(principal),
  });
  return { run };
}

export async function pipelineRunsResumeHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await requireCan(actorFor(principal.userId), 'project.write', projectResource(loaded.projectId));
  const run = await resumePipelineRun(input.runId, {
    type: 'user',
    id: principalUserId(principal),
    agency: principalAgency(principal),
  });
  return { run };
}

export async function pipelineRunsCancelHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsCancelInputSchema>,
) {
  const loaded = await loadRunForPrincipal(principal, input.runId);
  await requireCan(actorFor(principal.userId), 'project.write', projectResource(loaded.projectId));
  return cancelPipelineRun(input.runId, {
    actorUserId: principalUserId(principal),
    actorAgency: principalAgency(principal),
    ...(input.parkIssue !== undefined ? { parkIssue: input.parkIssue } : {}),
  });
}
