// REQ-63: a release that goes out through change requests is merged, not deployed. Each request
// merges through `merge-pull-request` only as a step of an approved running release, in its declared
// order; the last merge closes the roster and completes the run.

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import type { TransitionActor } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal, refuser } from '../lib/refusal.js';
import { consume } from '../outbox/index.js';
import { closeRunIfOneShot, stampReleaseShipped } from '../pipeline/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { projectCreatorOf } from '../projects/index.js';
import { assertApprovalAllowsAttempt } from './approvals.js';
import { label, linksOf, mergeStepsOf } from './change-request-roster.js';
import { closeRoster } from './finish.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';

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

/** Why a settle closed nothing yet: a request still open, a stamp not written, another settling. */
type SettlePending = 'merges' | 'stamps' | 'settling';

/** How long one settle holds its release before another may take it over. */
const SETTLE_LEASE = sql`interval '5 minutes'`;

/** The settle's hold on its release, taken where none is held or the last one lapsed. */
async function takeSettleLease(runId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    UPDATE pipeline_runs
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{settling}', to_jsonb(now()::text))
     WHERE id = ${runId} AND status = 'running'
       AND (metadata->>'settling' IS NULL OR (metadata->>'settling')::timestamptz < now() - ${SETTLE_LEASE})
    RETURNING id`);
  return [...rows].length > 0;
}

/**
 * The release closed once its last change request merged and every issue it carries holds its merge:
 * the roster closes, the ship is stamped, and the run completes. A call before then changes nothing
 * and says what it waits on; one settle runs at a time, under a lease on the run.
 */
export async function settleChangeRequestRelease(
  runId: string,
  actor: TransitionActor,
): Promise<{ settled: boolean; pending: SettlePending | null }> {
  const [run] = await db
    .select({ status: pipelineRuns.status, metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const steps = run ? mergeStepsOf(run.metadata) : null;
  if (run?.status !== 'running' || !steps || steps.length === 0) {
    return { settled: false, pending: null };
  }
  const states = await db
    .select({ state: repoPullRequests.state })
    .from(repoPullRequests)
    .where(
      inArray(
        repoPullRequests.id,
        steps.map((s) => s.pullRequestId),
      ),
    );
  if (states.length < steps.length || states.some((s) => s.state !== 'merged')) {
    return { settled: false, pending: 'merges' };
  }
  const claimed = await db
    .select({
      id: issues.id,
      status: issues.status,
      reopenCount: issues.reopenCount,
      projectId: issues.projectId,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));
  // a host's report of the last merge can arrive before its stamp is written
  if (claimed.some((c) => c.mergedAt === null)) return { settled: false, pending: 'stamps' };
  if (!(await takeSettleLease(runId))) return { settled: false, pending: 'settling' };
  const { failed } = await closeRoster(claimed, runId, actor, undefined);
  await stampReleaseShipped(runId);
  await recoverStrandedReleasing(runId, {
    reason: 'the release merged its change requests but this issue could not be closed',
    actorUserId: actor.type === 'user' ? actor.id : undefined,
    comment: true,
  });
  await closeRunIfOneShot(runId, 'completed');
  if (failed.length > 0) logger.warn({ runId, failed }, 'change-request release: issues left open');
  return { settled: true, pending: null };
}

/**
 * The release's own reaction to a merge its host reported: every running change-request release
 * holding an issue the merged request delivers is settled. A settle that has to wait on a stamp not
 * yet written, or on another settle, throws, so the delivery is retried rather than forgotten.
 */
export function registerChangeRequestSettle(): void {
  consume('source.merged', {
    name: 'release-merge-settle',
    handle: async (p) => {
      const delivered = await db
        .selectDistinct({ issueId: repoPullRequestIssues.issueId })
        .from(repoPullRequestIssues)
        .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
        .where(
          and(eq(repoPullRequests.projectId, p.projectId), eq(repoPullRequests.headRef, p.headRef)),
        );
      const owner = await projectCreatorOf(p.projectId);
      if (!owner || delivered.length === 0) return;
      const runs = await db
        .selectDistinct({ runId: issues.releaseBatchRunId })
        .from(issues)
        .where(
          and(
            inArray(
              issues.id,
              delivered.map((d) => d.issueId),
            ),
            isNotNull(issues.releaseBatchRunId),
          ),
        );
      for (const r of runs) {
        if (!r.runId) continue;
        const out = await settleChangeRequestRelease(r.runId, {
          type: 'user',
          id: owner,
          agency: 'agent',
        });
        if (out.pending === 'stamps' || out.pending === 'settling') {
          throw new Error(
            `release run ${r.runId}: every change request merged, and the release waits on ${out.pending === 'stamps' ? 'a merge stamp not yet written' : 'another settle'}; retried`,
          );
        }
      }
    },
  });
}
