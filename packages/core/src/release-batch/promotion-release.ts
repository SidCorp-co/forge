// REQ-63 BC-9..12: a project whose production is deployed outside Forge, declaring one promotion into
// the branch production deploys from, releases through that promotion's change request. The cut
// pins the request and the roster issues its head carries; approval is the go to merge it, through
// Forge or on the host, either seen in the projection; the operator's record of the deploy closes it.

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import type { ReleasePromotion } from '@forge/contracts/releases';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { releaseRunClaims } from '../issues/index.js';
import { closeRunIfOneShot, stampReleaseShipped } from '../pipeline/index.js';
import { requestApproval } from './approvals.js';
import { label, type ReleaseMergeStep, shown } from './change-request-roster.js';
import { releaseProbesOf } from './channel.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
import {
  type Across,
  carriedBy,
  openPromotionFor,
  type PromotionDeclaration,
  requestsAcross,
} from './promotion-standing.js';
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

/** A promotion request the host merged, as the projection holds it. */
export type MergedPromotion = typeof repoPullRequests.$inferSelect & { mergeCommitSha: string };

/**
 * Cuts the release as its promotion request: the run pins it, and the owner is asked for the go.
 * Handed a request already `merged` on the host, the release is that merge, read against its merge
 * commit, and asks no go: the merge was it (`recordPromotionRelease`).
 */
export async function cutPromotionRelease(
  args: { projectId: string; issueIds: string[]; userId: string; naming?: ReleaseNaming | null },
  decl: PromotionDeclaration,
  openClaimedRun: OpenRun,
  merged?: MergedPromotion,
) {
  const { projectId, issueIds, userId } = args;
  const [request] = merged ? [merged] : await requestsAcross(projectId, decl.promotion);
  if (!request) {
    throw blockerRefusal('RELEASE_PROMOTION_MISSING', {
      issueIds,
      displayIds: await shown(issueIds),
      ...decl.promotion,
    });
  }
  const { carries, notCarried } = await carriedBy(
    projectId,
    merged ? merged.mergeCommitSha : request.headSha,
    issueIds,
  );
  if (merged && notCarried.length > 0) {
    const named = (await shown(notCarried)).map((id) => `\`${id}\``).join(', ');
    throw refuseRelease(
      'RELEASE_PROMOTION_MISSING',
      `${label(merged)} merged into \`${decl.promotion.to}\` at ${merged.mergeCommitSha}, which does not hold the landing of ${named}: production does not carry ${notCarried.length === 1 ? 'it' : 'them'}, so this record cannot close ${notCarried.length === 1 ? 'it' : 'them'}. Record only the issues the merge carries; the rest wait for the next promotion.`,
      '/issueIds',
    );
  }
  if (notCarried.length > 0) {
    throw blockerRefusal('RELEASE_PROMOTION_MISSING', {
      issueIds: notCarried,
      displayIds: await shown(notCarried),
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
  if (!merged)
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
  return viewOf(request, p.to, p.carries, p.notCarried, keyOf);
}

/**
 * The open promotion request a draft pairs with, and which of its roster that head carries, read on
 * the host (adminhub-fe 0.54.0: !2055 carried 7 of 9). Null where the release is no promotion or none is open.
 */
export async function draftPromotionViewOf(
  projectId: string,
  roster: readonly string[],
  keyOf: (issueId: string) => string,
): Promise<ReleasePromotion | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (decl?.kind !== 'promotion') return null;
  const open = await openPromotionFor(projectId, decl.promotion, roster);
  return open
    ? viewOf(open.request, decl.promotion.to, open.carries, open.notCarried, keyOf)
    : null;
}

function viewOf(
  request: typeof repoPullRequests.$inferSelect,
  to: string,
  carries: string[],
  notCarried: string[],
  keyOf: (issueId: string) => string,
): ReleasePromotion {
  const keys = (ids: string[]) => ids.map(keyOf);
  return {
    label: label(request),
    number: request.number,
    title: request.title,
    url: request.htmlUrl,
    state: request.state === 'merged' ? 'merged' : request.state === 'open' ? 'open' : 'closed',
    // the branch the request merges from, which may be one cut from the promotion's source to pin a head
    from: request.headRef,
    to,
    headSha: request.headSha,
    mergeCommitSha: request.mergeCommitSha,
    carries: keys(carries),
    notCarried: keys(notCarried),
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

/** The newest promotion request merged into `to` whose merge production serving `commit` holds. */
async function mergedPromotionServed(
  projectId: string,
  across: Across,
  commit: string,
): Promise<MergedPromotion | null> {
  const rows = await db
    .select()
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.baseRef, across.to),
        eq(repoPullRequests.state, 'merged'),
      ),
    )
    .orderBy(desc(repoPullRequests.mergedAt))
    .limit(5);
  for (const r of rows) {
    if (r.mergeCommitSha && !(await servesTheMerge(projectId, r.mergeCommitSha, commit)))
      return { ...r, mergeCommitSha: r.mergeCommitSha };
  }
  return null;
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
 * refused before its request merged, for a roster other than the release's, for a commit that
 * does not hold the merge, and for one missing a roster issue's landing (a head rewritten after the cut); verified by production's probes where it declares them, else by this record.
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
  cutMerged?: (issueIds: string[], merged: MergedPromotion) => Promise<unknown>,
) {
  const { projectId, userId, commit, account } = sent;
  let run = await runningPromotion(projectId);
  if (!run && cutMerged && WHOLE.test(commit)) {
    // merged on the host with no release cut: the record of its deploy is the release (adminhub-fe !2055)
    const merged = await mergedPromotionServed(projectId, decl.promotion, commit);
    if (merged) {
      await cutMerged(sent.issueIds, merged);
      run = await runningPromotion(projectId);
    }
  }
  const p = run ? promotionOf(run.metadata) : null;
  if (!run || !p) {
    throw refuseRelease(
      'RELEASE_PROMOTION_MISSING',
      `No promotion release is running on this project, and no request merged into \`${decl.promotion.to}\` is held by \`${commit}\`; production is deployed outside Forge through the promotion from \`${decl.promotion.from}\` into \`${decl.promotion.to}\`. Cut the release first (\`POST /api/projects/${projectId}/release-batches\`) and record its deploy once its request merged, or record the commit production serves from a merged promotion.`,
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
  // the head may have been rewritten on the host after the cut, dropping an issue: close only what production holds (ISS-747)
  const { notCarried: dropped } = await carriedBy(projectId, commit, roster);
  if (dropped.length > 0) {
    const named = (await shown(dropped)).map((id) => `\`${id}\``).join(', ');
    const cutAt = (run.metadata as { changeRequests?: ReleaseMergeStep[] }).changeRequests?.[0]
      ?.headSha;
    throw refuseRelease(
      'RELEASE_PROMOTION_DROPPED',
      `Production serving ${commit} does not hold the landing of ${named}: release ${run.version} was cut with ${label(request)} at ${cutAt ?? 'its pinned head'}, and it merged at ${request.mergeCommitSha} without ${dropped.length === 1 ? 'that issue' : 'those issues'}, so recording this deploy would close ${dropped.length === 1 ? 'it' : 'them'} unshipped. Promote ${dropped.length === 1 ? 'it' : 'them'} into \`${p.to}\`, deploy, and record the commit production then serves.`,
      '/commit',
    );
  }
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
