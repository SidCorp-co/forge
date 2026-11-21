// REQ-63: a release that goes out through change requests is merged, not deployed. Each request
// merges through `merge-pull-request` only as a step of an approved running release, in its declared
// order; `change-request-settle.ts` closes the release once its last request merged.

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { isRefusal, refuser } from '../lib/refusal.js';
import { readProjectDocument } from '../project-config/index.js';
import { approvalsOfRuns, assertApprovalAllowsAttempt } from './approvals.js';
import { changeRequestStates, label, linksOf, mergeStepsOf } from './change-request-roster.js';
import { resolveReleaseDeclaration } from './gate.js';

/** A merge refused by the release it belongs to answers on the merge route, under its codes. */
const refuseMerge = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The release run a merge is made for, read off the issues the request delivers. */
async function runHolding(issueIds: string[]) {
  if (issueIds.length === 0) return null;
  const rows = await db
    .selectDistinct({
      runId: pipelineRuns.id,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
    })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(and(inArray(issues.id, issueIds), isNotNull(issues.releaseBatchRunId)));
  return rows.find((r) => r.status === 'running') ?? null;
}

/** The running release whose merge steps pin this request (a promotion release, REQ-63 BC-11). */
async function runPinning(pullRequestId: string) {
  const [row] = await db
    .select({
      runId: pipelineRuns.id,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.status, 'running'),
        sql`${pipelineRuns.metadata} -> 'changeRequests' @> ${JSON.stringify([{ pullRequestId }])}::jsonb`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export type MergeAdmission =
  | { kind: 'free' }
  /**
   * A step of an approved release, merged only at `headSha`: the commit its approval names for the
   * release's last step (`evidence.commit`), else the head the step was cut at. Core derives it here;
   * the merge refuses a request whose head is anything else (ISS-1114).
   */
  | { kind: 'release'; runId: string; headSha: string; pinnedBy: 'approval' | 'cut' };

/**
 * The commit a release step merges at. The approval's `evidence.commit` names the last step's head
 * (a promotion is one step), so a head the owner approved again after it moved is the one merged; any
 * other step merges at the head it was cut at.
 */
async function pinOf(
  runId: string,
  steps: readonly { headSha: string }[],
  at: number,
): Promise<{ headSha: string; pinnedBy: 'approval' | 'cut' }> {
  const step = steps[at] as { headSha: string };
  if (at !== steps.length - 1) return { headSha: step.headSha, pinnedBy: 'cut' };
  const [latest] = await approvalsOfRuns([runId]);
  return latest?.decision === 'approved'
    ? { headSha: latest.evidenceCommit.toLowerCase(), pinnedBy: 'approval' }
    : { headSha: step.headSha, pinnedBy: 'cut' };
}

/**
 * Whether this change request may merge now, on a project that releases through change requests:
 * only as a step of a running release that carries it, after that release is approved, and only
 * when every request before it in the declared order has merged. Each refusal names its fault.
 * Where the release is a promotion, only a request into the promotion's `to` branch is a release
 * step; one into any other branch (the `from` work lands on, adminhub-api !5063) is a landing.
 */
export async function admitChangeRequestMerge(args: {
  projectId: string;
  pullRequestId: string;
}): Promise<MergeAdmission> {
  const doc = await readProjectDocument(args.projectId);
  const throughRequests = releaseThroughChangeRequests(doc?.document);
  const decl = throughRequests ? null : await resolveReleaseDeclaration(args.projectId);
  const promotion = decl?.kind === 'promotion' ? decl.promotion : null;
  if (!throughRequests && !promotion) return { kind: 'free' };
  const [pr] = await db
    .select({
      host: repoPullRequests.host,
      number: repoPullRequests.number,
      state: repoPullRequests.state,
      baseRef: repoPullRequests.baseRef,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, args.pullRequestId))
    .limit(1);
  if (!pr && promotion) {
    throw refuseMerge(
      'RELEASE_MERGE_TARGET_UNREAD',
      `Request ${args.pullRequestId} is not in Forge's projection of the repository, so the branch it merges into cannot be read, and this project releases through its promotion into \`${promotion.to}\`: only a request into that branch waits on a release. Refresh the request from the host, then merge it.`,
      '/pullRequest',
    );
  }
  if (!pr) return { kind: 'free' };
  if (promotion && pr.baseRef !== promotion.to) return { kind: 'free' };
  const me = label(pr);
  const linked = (await linksOf([args.pullRequestId])).get(args.pullRequestId) ?? [];
  // a promotion request delivers no issue by its branch: the release that pinned it holds it
  const run = (await runHolding(linked)) ?? (await runPinning(args.pullRequestId));
  const steps = run ? mergeStepsOf(run.metadata) : null;
  const at = steps?.findIndex((s) => s.pullRequestId === args.pullRequestId) ?? -1;
  if (!run || !steps || at < 0) {
    throw refuseMerge(
      'RELEASE_MERGE_UNRELEASED',
      `${me} is not a step of a running release, and this project releases through change requests: a request merges only as part of a release the owner approved. Cut a release naming the issues it delivers (\`POST /api/projects/${args.projectId}/release-batches\`), have it approved, then merge it.`,
      '/pullRequest',
    );
  }
  try {
    await assertApprovalAllowsAttempt(run.runId, args.projectId);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const why = err.refusals[0]?.detail ?? '';
    throw refuseMerge(
      'RELEASE_MERGE_NOT_APPROVED',
      `${me} is step ${at + 1} of release run ${run.runId}, which is not approved: ${why}. Nothing merges before the owner accepts the release.`,
      '/pullRequest',
    );
  }
  const stateOf = await changeRequestStates(steps.map((s) => s.pullRequestId));
  const first = steps.find((s) => stateOf.get(s.pullRequestId) !== 'merged');
  if (
    first &&
    first.pullRequestId !== args.pullRequestId &&
    stateOf.get(args.pullRequestId) !== 'merged'
  ) {
    throw refuseMerge(
      'RELEASE_MERGE_OUT_OF_ORDER',
      `${me} is step ${at + 1} of this release, and ${label(first)} (step ${steps.indexOf(first) + 1}) has not merged yet: the release merges ${steps.map(label).join(', ')} in that order. Merge ${label(first)} first.`,
      '/pullRequest',
    );
  }
  // whether the head still is that commit is read from the host at the merge, never the projection
  return { kind: 'release', runId: run.runId, ...(await pinOf(run.runId, steps, at)) };
}

/**
 * The run a caller names on a merge, held to the release the merge is admitted under (ISS-1349,
 * FB-759): a run that has ended, or an open run that is not the release run holding the request, is
 * refused by name before anything is sent, naming the run that holds the request, if any. A merge
 * naming no run keeps its admission. A run Forge holds no row of, or one of another project, is the
 * merge's own refusal (`integrations/source-host/merge.ts:assertCaller`).
 */
export async function refuseCallerRun(args: {
  projectId: string;
  runId: string | undefined;
  admitted: MergeAdmission;
}): Promise<void> {
  const { runId, admitted } = args;
  if (!runId) return;
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId, status: pipelineRuns.status })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run || run.projectId !== args.projectId) return;
  const holding = admitted.kind === 'release' ? admitted.runId : null;
  const holds = holding
    ? `Release run ${holding} holds this request: merge naming it, or naming no \`runId\`.`
    : 'No running release holds this request: merge naming no `runId`, or the open run it is made for.';
  if (!LIVE_PIPELINE_RUN_STATUSES.includes(run.status)) {
    throw refuseMerge(
      'MERGE_RUN_NOT_OPEN',
      `\`runId\` ${runId} names a run that is ${run.status}, not open, so nothing was merged: a merge made for a run that has ended leaves the branch ahead of production with no run to deploy it. ${holds}`,
      '/runId',
    );
  }
  if (holding && holding !== runId) {
    throw refuseMerge(
      'MERGE_RUN_NOT_THE_RELEASE',
      `\`runId\` ${runId} is not the release run this merge is admitted under, so nothing was merged. ${holds}`,
      '/runId',
    );
  }
}
