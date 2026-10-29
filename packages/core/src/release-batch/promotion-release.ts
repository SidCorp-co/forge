// REQ-63 BC-9..12: a project whose production is deployed outside Forge, declaring one promotion into
// the branch production deploys from, releases through that promotion's change request. The cut
// pins the request and the roster issues its head carries; approval is the go to merge it, through
// Forge or on the host, either seen in the projection; the operator's record of the deploy closes it.

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import type { ReleasePromotion } from '@forge/contracts/releases';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { releaseRunClaims } from '../issues/index.js';
import { closeRunIfOneShot, stampReleaseShipped } from '../pipeline/index.js';
import { requestApproval } from './approvals.js';
import { label, type ReleaseMergeStep } from './change-request-roster.js';
import { releaseProbesOf } from './channel.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { type Across, type PromotionDeclaration, requestsAcross } from './promotion-standing.js';
import { admissibleIssues, closeRecorded, writeLedger } from './recorded.js';
import { blockerRefusal, notVerifiedRefusal, refuseRelease } from './refuse.js';
import { verifyServingNow } from './verify.js';

/** The cut's own run opener (`create.ts:openClaimedRun`), handed in so neither module imports the other. */
type OpenRun = (args: {
  projectId: string;
  issueIds: string[];
  metadata: Record<string, unknown>;
  naming: ReleaseNaming | null;
  userId: string;
}) => Promise<{ run: { id: string }; version: string }>;

/** What a promotion release keeps on its run beside its one merge step. */
interface PromotionMetadata extends Across {
  pullRequestId: string;
  carries: string[];
  notCarried: string[];
}

const WHOLE = /^[0-9a-f]{40}$/i;

/** Of the roster, the issues whose host merge `head` holds, read on the host one compare each. */
async function carriedBy(projectId: string, head: string, roster: readonly string[]) {
  const rows = await db
    .select({ id: issues.id, sha: issues.mergedCommitSha })
    .from(issues)
    .where(inArray(issues.id, [...roster]));
  const host = await resolveSourceHost(projectId, 'agent');
  const carries: string[] = [];
  const notCarried: string[] = [];
  for (const r of rows) {
    const where = r.sha ? await host.compare(r.sha, head) : null;
    (where === 'ahead' || where === 'identical' ? carries : notCarried).push(r.id);
  }
  return { carries, notCarried };
}

/** Cuts the release as its promotion request: the run pins it, and the owner is asked for the go. */
export async function cutPromotionRelease(
  args: { projectId: string; issueIds: string[]; userId: string; naming?: ReleaseNaming | null },
  decl: PromotionDeclaration,
  openClaimedRun: OpenRun,
) {
  const { projectId, issueIds, userId } = args;
  const [request] = await requestsAcross(projectId, decl.promotion);
  if (!request) {
    throw blockerRefusal('RELEASE_PROMOTION_MISSING', { issueIds, ...decl.promotion });
  }
  const { carries, notCarried } = await carriedBy(projectId, request.headSha, issueIds);
  if (notCarried.length > 0) {
    throw blockerRefusal('RELEASE_PROMOTION_MISSING', {
      issueIds: notCarried,
      ...decl.promotion,
    });
  }
  const step: ReleaseMergeStep = {
    pullRequestId: request.id,
    host: request.host,
    number: request.number,
    headSha: request.headSha,
    issueIds,
  };
  const promotion: PromotionMetadata = {
    ...decl.promotion,
    pullRequestId: request.id,
    carries,
    notCarried,
  };
  const probed = releaseProbesOf(decl.production).verify !== null;
  const { run, version } = await openClaimedRun({
    projectId,
    issueIds,
    metadata: {
      source: 'release-batch',
      gateStatus: RELEASE_GATE_STATUS,
      issueIds,
      deployPlanned: false,
      promotePlanned: false,
      verification: probed ? 'probed' : 'deployment',
      changeRequests: [step],
      promotion,
    },
    naming: args.naming ?? null,
    userId,
  });
  const me = label(request);
  const across = `\`${decl.promotion.from}\` into \`${decl.promotion.to}\``;
  const reading =
    request.state === 'merged'
      ? `${me} (${across}) merged at ${request.mergeCommitSha ?? 'a commit the host has not reported'}; the operator deploys production and records it.`
      : `Merges ${me} (${across}) at ${request.headSha.slice(0, 12)} once approved; the operator then deploys production and records it.`;
  await requestApproval({
    projectId,
    runId: run.id,
    userId,
    body: { evidence: { commit: request.headSha, reading: reading.slice(0, 500) } },
  });
  return {
    runId: run.id,
    jobId: null,
    issueIds,
    gateStatus: RELEASE_GATE_STATUS,
    version,
    ownerDeadlineAt: null,
    openedAfterRelease: false,
    verification: probed ? ('probed' as const) : ('deployment' as const),
    changeRequests: [{ number: request.number, label: me, headSha: request.headSha }],
  };
}

export function promotionOf(metadata: unknown): PromotionMetadata | null {
  const p = (metadata as { promotion?: unknown } | null)?.promotion;
  return p && typeof p === 'object' ? (p as PromotionMetadata) : null;
}

/** The promotion a release run is, as the page shows it: where its request stands now, read off the projection. */
export async function promotionViewOf(
  runId: string | null,
  keyOf: (issueId: string) => string,
): Promise<ReleasePromotion | null> {
  if (!runId) return null;
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const p = promotionOf(run?.metadata);
  if (!p) return null;
  const [request] = await db
    .select()
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, p.pullRequestId))
    .limit(1);
  if (!request) return null;
  const keys = (ids: string[]) => ids.map(keyOf);
  return {
    label: label(request),
    number: request.number,
    title: request.title,
    url: request.htmlUrl,
    state: request.state === 'merged' ? 'merged' : request.state === 'open' ? 'open' : 'closed',
    from: p.from,
    to: p.to,
    headSha: request.headSha,
    mergeCommitSha: request.mergeCommitSha,
    carries: keys(p.carries),
    notCarried: keys(p.notCarried),
  };
}

/** The running promotion release of a project: at most one release runs at a time. */
async function runningPromotion(projectId: string) {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      version: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.status, 'running'),
        sql`${pipelineRuns.metadata} ? 'promotion'`,
      ),
    )
    .limit(1);
  return run ?? null;
}

/** Whether production serving `commit` holds the promotion's merge, read on the host; why not, else. */
async function servesTheMerge(
  projectId: string,
  merge: string,
  commit: string,
): Promise<string | null> {
  const where = await resolveSourceHost(projectId, 'agent').then((h) => h.compare(merge, commit));
  return where === 'ahead' || where === 'identical'
    ? null
    : `${commit} does not hold the promotion's merge ${merge} (the host reads it ${where})`;
}

/**
 * The operator's record of the production deploy that closes a promotion release (REQ-63 BC-12):
 * refused before its request merged, for a roster other than the release's, and for a commit that
 * does not hold the merge; verified by production's probes where it declares them, else by this record.
 */
export async function recordPromotionRelease(
  sent: {
    projectId: string;
    userId: string;
    issueIds: string[];
    commit: string;
    account: string;
    providerRef?: string | undefined;
  },
  decl: PromotionDeclaration,
) {
  const { projectId, userId, commit, account } = sent;
  const run = await runningPromotion(projectId);
  const p = run ? promotionOf(run.metadata) : null;
  if (!run || !p) {
    throw refuseRelease(
      'RELEASE_PROMOTION_MISSING',
      `No promotion release is running on this project, and production is deployed outside Forge through the promotion from \`${decl.promotion.from}\` into \`${decl.promotion.to}\`: cut the release first (\`POST /api/projects/${projectId}/release-batches\`), and record its deploy once its request merged.`,
      '/issueIds',
    );
  }
  const roster = ((run.metadata as { issueIds?: string[] }).issueIds ?? []).map((id) =>
    id.toLowerCase(),
  );
  const named = sent.issueIds.map((id) => id.toLowerCase());
  if (named.length !== roster.length || named.some((id) => !roster.includes(id))) {
    throw refuseRelease(
      'RELEASE_PROMOTION_ROSTER',
      `Release ${run.version} carries ${roster.join(', ')}, and this record names ${named.join(', ')}: a promotion release closes its whole roster, so name exactly the issues it carries.`,
      '/issueIds',
    );
  }
  const [request] = await db
    .select()
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, p.pullRequestId))
    .limit(1);
  if (request?.state !== 'merged' || !request.mergeCommitSha) {
    throw refuseRelease(
      'RELEASE_PROMOTION_UNMERGED',
      `${request ? label(request) : 'The promotion request'} is ${request?.state ?? 'gone from the projection'}, not merged: release ${run.version} is deployed from its merge. Approve the release and merge it, or merge it on the host, then deploy and record.`,
      '/commit',
    );
  }
  if (!WHOLE.test(commit))
    throw notVerifiedRefusal(`\`${commit}\` is not a whole commit sha`, null);
  const off = await servesTheMerge(projectId, request.mergeCommitSha, commit);
  if (off) throw notVerifiedRefusal(off, commit);
  const { verify } = releaseProbesOf(decl.production);
  const read = verify
    ? await verifyServingNow({ cfg: verify, expected: commit })
    : { ok: true as const, identity: commit, readings: [`recorded by the operator: ${commit}`] };
  if (!read.ok) throw notVerifiedRefusal(read.reason, read.live);
  const how = verify ? ('probed' as const) : ('deployment' as const);
  const outcome = {
    identity: read.identity,
    readings: read.readings,
    health: verify ? ('up' as const) : null,
  };
  const providerRef = sent.providerRef ?? null;
  await writeLedger(run.id, { commit, outcome, account, providerRef, how });
  const issuesOf = await admissibleIssues(projectId, roster);
  const note = `Deployed to production from ${label(request)}'s merge ${request.mergeCommitSha}, serving \`${commit}\` (${how === 'probed' ? 'read on the live probes' : 'as the operator recorded it'}).\n\n${account}`;
  const { closed, failed } = await closeRecorded(issuesOf, {
    projectId,
    userId,
    account,
    note,
    runId: run.id,
  });
  await releaseRunClaims(run.id);
  await closeRunIfOneShot(run.id, failed.length > 0 ? 'failed' : 'completed', {
    code: 'release_record_incomplete',
    detail: `${failed.length} of the recorded issues would not close: ${failed.map((f) => `${f.id} (${f.reason})`).join('; ')}`,
  });
  if (failed.length === 0) await stampReleaseShipped(run.id);
  return {
    runId: run.id,
    version: run.version,
    commit,
    identity: read.identity,
    readings: read.readings,
    verification: how,
    closed,
    failed,
    issues: issuesOf,
  };
}
