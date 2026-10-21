/**
 * Where a report about Forge came from (REQ-47 BC-4): the project, issue and run its reporter was in,
 * and the client they used. An agent's box credential names its live job, which is read, never asked;
 * what the caller names itself (`from`) must agree with that job and sit in a project they can read,
 * so a report never claims a place its reporter could not have been.
 */

import type { ForgeFeedbackFrom } from '@forge/contracts/forge-feedback';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import type { Refusal } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { type ForgeSource, forgeRefusal } from './forge-intake.js';

export interface ForgeCaller extends PipelineCaller {
  userId: string;
}

async function projectOfIssue(id: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, id))
    .limit(1);
  return row?.projectId ?? null;
}

async function projectOfRun(id: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, id))
    .limit(1);
  return row?.projectId ?? null;
}

const mismatch = (field: keyof ForgeFeedbackFrom, said: string, live: string | null) =>
  forgeRefusal(
    'FORGE_FEEDBACK_SOURCE_MISMATCH',
    `/from/${field}`,
    `from.${field} names ${said}, and the job this credential runs is in ${live ?? 'none'}; leave from.${field} out and it is read from the job, or send the one the job is in.`,
  );

/** The source of one report, or the refusal naming the part of `from` that cannot stand. */
export async function resolveForgeSource(
  caller: ForgeCaller,
  from: ForgeFeedbackFrom | undefined,
  clientVersion: string | undefined,
): Promise<ForgeSource | Refusal> {
  const resolved = caller.deviceId ? await resolvePipelineContext(caller) : null;
  const live = resolved?.ok ? resolved.context : null;
  const liveProject = live ? caller.boundProjectId : null;
  if (live) {
    if (from?.project && from.project !== liveProject)
      return mismatch('project', `project ${from.project}`, liveProject);
    if (from?.issue && from.issue !== live.issueId)
      return mismatch('issue', `issue ${from.issue}`, live.issueId);
    if (from?.run && from.run !== live.runId) return mismatch('run', `run ${from.run}`, live.runId);
  }
  let projectId = from?.project ?? liveProject ?? caller.boundProjectId ?? null;
  const issueId = from?.issue ?? live?.issueId ?? null;
  const runId = from?.run ?? live?.runId ?? null;
  for (const [field, id, owner] of [
    ['issue', issueId, issueId ? await projectOfIssue(issueId) : null],
    ['run', runId, runId ? await projectOfRun(runId) : null],
  ] as const) {
    if (!id) continue;
    if (!owner) {
      return forgeRefusal(
        'FORGE_FEEDBACK_SOURCE_UNREADABLE',
        `/from/${field}`,
        `no ${field} has id ${id}; name one you were working in, or leave from.${field} out.`,
      );
    }
    if (projectId && owner !== projectId) {
      return forgeRefusal(
        'FORGE_FEEDBACK_SOURCE_MISMATCH',
        `/from/${field}`,
        `${field} ${id} is in project ${owner}, not in project ${projectId}; name the ${field} and the project it is in.`,
      );
    }
    projectId = owner;
  }
  const access = projectId ? await effectiveProjectRole(caller.userId, projectId) : null;
  if (projectId && !(access && holds(access, 'project.read'))) {
    return forgeRefusal(
      'FORGE_FEEDBACK_SOURCE_UNREADABLE',
      from?.project ? '/from/project' : '/from',
      `you cannot read project ${projectId} (you are not a member, or your credential does not reach it), so a report cannot say it came from there; name a project you work in, or leave from out.`,
    );
  }
  return { projectId, issueId, runId, clientVersion: clientVersion ?? null };
}
