/**
 * ISS-102 / ISS-145 — the pipeline-run actions. The five action functions
 * (list/get/pause/resume/cancel) carry the logic — auth check, db read, control
 * call — and `forge_project_pipeline_runs` dispatches into all five.
 */

import { z } from 'zod';
import { pipelineRunStatuses } from '../db/schema.js';
import { principalAgency } from '../issues/index.js';
import { buildListEnvelope, overfetch } from '../lib/list-envelope.js';
import { principalUserId } from '../lib/tool.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { countRunJobsByStatus, listPipelineRuns, readPipelineRun } from './runs.js';
import { cancelPipelineRun, pausePipelineRun, resumePipelineRun } from './runs-control.js';
import { laneOf } from './runs-lane.js';
import { loadRunLivenessByRunIds, residentMasterOn } from './runs-liveness.js';

export const pipelineRunsListInputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid().optional(),
    status: z.enum(pipelineRunStatuses).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const pipelineRunsRunIdInputSchema = z.object({ runId: z.uuid() }).strict();

export const pipelineRunsCancelInputSchema = z
  .object({ runId: z.uuid(), parkIssue: z.boolean().optional() })
  .strict();

async function loadRunForPrincipal(principal: McpPrincipal, runId: string) {
  const row = await readPipelineRun(runId);
  if (!row) throw new Error('NOT_FOUND: pipeline run not found');
  await requireCan(actorFor(principal.userId), 'project.read', projectResource(row.projectId));
  return row;
}

export async function pipelineRunsListHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsListInputSchema>,
) {
  await requireCan(actorFor(principal.userId), 'project.read', projectResource(input.projectId));

  const runsLimit = input.limit ?? 50;
  const rows = await listPipelineRuns({
    projectId: input.projectId,
    issueId: input.issueId,
    status: input.status,
    limit: overfetch(runsLimit),
  });
  // ISS-1335 — the lane and the live master come from the REST list's own derivation, so the
  // two surfaces cannot disagree about what a run is; the metadata that decides it is not returned.
  const liveness = await loadRunLivenessByRunIds(rows.map((r) => r.id));
  const items = rows.map(({ metadata, ...row }) => {
    const lane = laneOf({ issueId: row.issueId, metadata });
    const live = liveness.get(row.id);
    return {
      ...row,
      liveJobs: live?.liveJobs ?? 0,
      lane,
      residentMaster: residentMasterOn(lane, live),
    };
  });

  return buildListEnvelope({
    key: 'runs',
    items,
    limit: runsLimit,
    hint: 'narrow with status/issueId filters',
  });
}

export async function pipelineRunsGetHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pipelineRunsRunIdInputSchema>,
) {
  const run = await loadRunForPrincipal(principal, input.runId);

  const jobCounts = await countRunJobsByStatus(input.runId);
  return { run, jobCounts };
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
