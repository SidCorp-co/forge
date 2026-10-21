/**
 * Where a report about Forge came from (REQ-47 BC-4): the project, issue and run its reporter was in,
 * and the client they used. An agent's box credential names its live job, which is read, never asked;
 * what the caller names itself (`from`) must agree with that job and sit in a project they can read,
 * so a report never claims a place its reporter could not have been.
 */

import { RUN_ISSUES_METADATA_KEY } from '@forge/contracts/agent-sessions';
import type { ForgeFeedbackFrom } from '@forge/contracts/forge-feedback';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import type { Refusal } from '../lib/refusal.js';
import { holds } from '../permissions/index.js';
import { type ForgeSource, forgeRefusal } from './forge-intake.js';
import { issueRefIn } from './refs.js';

export interface ForgeCaller extends PipelineCaller {
  userId: string;
  /**
   * The project the caller's connection names, by slug: MCP's `X-Forge-Project-Slug`, the header
   * every other tool resolves its project from. `id` is null where no project has that slug.
   */
  named?: { slug: string; id: string | null } | null;
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

/**
 * The one issue a run works: its own, or the single issue a declared run was opened for. A run
 * working several issues names none of them, and the caller says which with from.issue.
 */
async function issueOfRun(id: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({
      projectId: pipelineRuns.projectId,
      issueId: pipelineRuns.issueId,
      keys: sql<unknown>`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY}`,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, id))
    .limit(1);
  if (!row) return null;
  if (row.issueId) return row.issueId;
  const keys = Array.isArray(row.keys) ? row.keys : [];
  const [only] = keys;
  if (keys.length !== 1 || typeof only !== 'string') return null;
  const issue = await issueRefIn(row.projectId, only, userId, '/from/issue');
  return 'id' in issue ? issue.id : null;
}

const reads = async (userId: string, projectId: string) => {
  const access = await effectiveProjectRole(userId, projectId);
  return access !== null && holds(access, 'project.read');
};

/** The refusal the project a connection names earns, or null where it stands beside `from`. */
async function namedRefusal(
  caller: ForgeCaller,
  from: ForgeFeedbackFrom | undefined,
): Promise<Refusal | null> {
  const named = caller.named;
  if (!named) return null;
  if (!named.id || !(await reads(caller.userId, named.id))) {
    return forgeRefusal(
      'FORGE_FEEDBACK_SOURCE_UNREADABLE',
      '',
      `this connection names project "${named.slug}" (X-Forge-Project-Slug), and no project you can read with this credential has that slug, so a report cannot say it came from there; name the project you work in, or send the report without the header.`,
    );
  }
  if (from?.project && from.project !== named.id) {
    return forgeRefusal(
      'FORGE_FEEDBACK_SOURCE_MISMATCH',
      '/from/project',
      `from.project names project ${from.project}, and this connection names project "${named.slug}" (X-Forge-Project-Slug); leave from.project out and the connection's project is recorded, or send the one it names.`,
    );
  }
  return null;
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
  const namedRefused = await namedRefusal(caller, from);
  if (namedRefused) return namedRefused;
  const resolved = caller.deviceId ? await resolvePipelineContext(caller) : null;
  const live = resolved?.ok ? resolved.context : null;
  const liveProject = live ? caller.boundProjectId : null;
  // a session running a job is that job's; one running none is its own run's, a declared run's
  const liveRun = live ? (live.runId ?? live.sessionRunId) : null;
  if (live) {
    if (from?.project && from.project !== liveProject)
      return mismatch('project', `project ${from.project}`, liveProject);
    if (from?.issue && live.issueId && from.issue !== live.issueId)
      return mismatch('issue', `issue ${from.issue}`, live.issueId);
    if (from?.run && from.run !== liveRun) return mismatch('run', `run ${from.run}`, liveRun);
  }
  let projectId = from?.project ?? liveProject ?? caller.boundProjectId ?? caller.named?.id ?? null;
  const issueId =
    from?.issue ??
    live?.issueId ??
    (live && liveRun ? await issueOfRun(liveRun, caller.userId) : null);
  const runId = from?.run ?? liveRun;
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
  if (projectId && !(await reads(caller.userId, projectId))) {
    return forgeRefusal(
      'FORGE_FEEDBACK_SOURCE_UNREADABLE',
      from?.project ? '/from/project' : '/from',
      `you cannot read project ${projectId} (you are not a member, or your credential does not reach it), so a report cannot say it came from there; name a project you work in, or leave from out.`,
    );
  }
  return { projectId, issueId, runId, clientVersion: clientVersion ?? null };
}
