// REQ-63: a release that goes out through change requests is merged, not deployed. Each request
// merges through `merge-pull-request` only as a step of an approved running release, in its declared
// order; `change-request-settle.ts` closes the release once its last request merged.

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { isRefusal, refuser } from '../lib/refusal.js';
import { readProjectDocument } from '../project-config/index.js';
import { assertApprovalAllowsAttempt } from './approvals.js';
import { label, linksOf, mergeStepsOf } from './change-request-roster.js';

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

type MergeAdmission =
  | { kind: 'free' }
  /** A step of an approved release: merged at the head the release was cut and approved at. */
  | { kind: 'release'; runId: string; headSha: string };

/**
 * Whether this change request may merge now, on a project that releases through change requests:
 * only as a step of a running release that carries it, after that release is approved, and only
 * when every request before it in the declared order has merged. Each refusal names its fault.
 */
export async function admitChangeRequestMerge(args: {
  projectId: string;
  pullRequestId: string;
}): Promise<MergeAdmission> {
  const doc = await readProjectDocument(args.projectId);
  if (!releaseThroughChangeRequests(doc?.document)) return { kind: 'free' };
  const [pr] = await db
    .select({
      host: repoPullRequests.host,
      number: repoPullRequests.number,
      headSha: repoPullRequests.headSha,
      state: repoPullRequests.state,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, args.pullRequestId))
    .limit(1);
  if (!pr) return { kind: 'free' };
  const me = label(pr);
  const linked = (await linksOf([args.pullRequestId])).get(args.pullRequestId) ?? [];
  const run = await runHolding(linked);
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
  const step = steps[at] as (typeof steps)[number];
  if (pr.state !== 'merged' && pr.headSha.toLowerCase() !== step.headSha.toLowerCase()) {
    throw refuseMerge(
      'RELEASE_MERGE_NOT_APPROVED',
      `${me} moved to ${pr.headSha.slice(0, 12)} since release run ${run.runId} was cut at ${step.headSha.slice(0, 12)}, and the owner approved the head it was cut at, not this one. Abort the release and cut it again on the new head.`,
      '/pullRequest',
    );
  }
  const states = await db
    .select({ id: repoPullRequests.id, state: repoPullRequests.state })
    .from(repoPullRequests)
    .where(
      inArray(
        repoPullRequests.id,
        steps.map((s) => s.pullRequestId),
      ),
    );
  const stateOf = new Map(states.map((s) => [s.id, s.state]));
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
  return { kind: 'release', runId: run.runId, headSha: step.headSha };
}
