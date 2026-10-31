// REQ-63 BC-9..12: a project whose production is deployed outside Forge, declaring one promotion into
// the branch production deploys from, releases through that promotion's change request. The cut pins
// the request the agent names and the roster the agent states; approval is the go to merge it, through
// Forge or on the host, either seen in the projection; the operator's record of the deploy closes it.
// Nothing here asks the host which issues a request carries: the agent states it (owner ruling 2026-10-29).

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import type { ReleasePromotion } from '@forge/contracts/releases';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { releaseRunClaims } from '../issues/index.js';
import { closeRunIfOneShot, stampReleaseShipped } from '../pipeline/index.js';
import { requestApproval } from './approvals.js';
import { label, type ReleaseMergeStep } from './change-request-roster.js';
import { releaseProbesOf } from './channel.js';
import { assertDeclaredGate } from './declared-gate.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
import { type Across, type PromotionDeclaration, requestsAcross } from './promotion-standing.js';
import { admissibleIssues, closeRecorded, writeLedger } from './recorded.js';
import { notVerifiedRefusal, refuseRelease } from './refuse.js';
import { oweReleaseTag } from './release-tag.js';
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
}

const WHOLE = /^[0-9a-f]{40}$/i;

/**
 * Cuts the release as the promotion request the agent names (`promotion.request`) and the roster it
 * states. The request must be one the projection holds across the declared promotion, open or merged
 * and not yet released. Handed one already `merged`, the release is that merge and asks no go: the
 * merge was it, and the record of the deploy closes it (ISS-762, catalog-api 0.3.0: !1023 was already on
 * release/production). An open one asks the owner for the go to merge it.
 */
export async function cutPromotionRelease(
  args: {
    projectId: string;
    issueIds: string[];
    userId: string;
    naming?: ReleaseNaming | null;
    promotion?: { request: number } | undefined;
  },
  decl: PromotionDeclaration,
  openClaimedRun: OpenRun,
) {
  const { projectId, issueIds, userId } = args;
  const across = `\`${decl.promotion.from}\` into \`${decl.promotion.to}\``;
  const held = await requestsAcross(projectId, decl.promotion);
  if (!args.promotion) {
    const open = held.map((r) => label(r)).join(', ');
    throw refuseRelease(
      'RELEASE_PROMOTION_REQUEST_UNNAMED',
      `This project releases through its promotion ${across}: name the change request that carries the roster as \`promotion: { request: <number> }\`.${open ? ` Open or merged and unreleased now: ${open}.` : ''} You state which issues it carries; Forge does not read the host to decide.`,
      '/promotion',
    );
  }
  const request = held.find((r) => r.number === args.promotion?.request);
  if (!request) {
    const open = held.map((r) => label(r)).join(', ');
    throw refuseRelease(
      'RELEASE_PROMOTION_REQUEST_UNKNOWN',
      `!${args.promotion.request} is not a change request this project holds across its promotion ${across}, open or merged and not yet released${open ? `; those are ${open}` : ''}. Name one of them, or wait for the host's hook to bring the request in.`,
      '/promotion/request',
    );
  }
  // the promotion carries the request's head to production: the declared gate is read at that head
  await assertDeclaredGate(projectId, {
    request: { number: request.number, headSha: request.headSha },
  });
  const step: ReleaseMergeStep = {
    pullRequestId: request.id,
    host: request.host,
    number: request.number,
    headSha: request.headSha,
    issueIds,
  };
  const promotion: PromotionMetadata = { ...decl.promotion, pullRequestId: request.id };
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
  // a promotion already merged when the release is cut is seen merged now: its tag is owed on the
  // merge before anything is deployed from it (REQ-63 BC-13); one still open owes it when it merges
  if (request.state === 'merged' && request.mergeCommitSha) {
    await oweReleaseTag(run.id, request.mergeCommitSha, 'promotion');
  }
  const me = label(request);
  const reading =
    request.state === 'merged'
      ? `${me} (${across}) merged at ${request.mergeCommitSha ?? 'a commit the host has not reported'}; the operator deploys production and records it.`
      : `Merges ${me} (${across}) at ${request.headSha.slice(0, 12)} once approved; the operator then deploys production and records it.`;
  if (request.state !== 'merged')
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
  const stated = (run?.metadata as { issueIds?: string[] } | null)?.issueIds ?? [];
  return viewOf(request, p.to, stated, keyOf);
}

/**
 * The promotion request a draft pairs with, as the projection holds it (the open one, else a merged one
 * no release has taken), shown beside the issues waiting. Null where the release is no promotion or
 * none is held. Nothing asks the host which of the roster it carries: the agent states that at the cut.
 */
export async function draftPromotionViewOf(
  projectId: string,
  roster: readonly string[],
  keyOf: (issueId: string) => string,
): Promise<ReleasePromotion | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (decl?.kind !== 'promotion') return null;
  const [request] = await requestsAcross(projectId, decl.promotion);
  return request ? viewOf(request, decl.promotion.to, roster, keyOf) : null;
}

function viewOf(
  request: typeof repoPullRequests.$inferSelect,
  to: string,
  roster: readonly string[],
  keyOf: (issueId: string) => string,
): ReleasePromotion {
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
    roster: roster.map(keyOf),
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

/**
 * The operator's record of the production deploy that closes a promotion release (REQ-63 BC-12):
 * refused before its request merged and for a roster other than the release's; verified by
 * production's probes where it declares them, else by the agent's statement. No host compare: which
 * commit production serves is what the agent says, and the promotion's merge is read off the projection.
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
      `No promotion release is running on this project; production is deployed outside Forge through the promotion from \`${decl.promotion.from}\` into \`${decl.promotion.to}\`. Cut the release first (\`POST /api/projects/${projectId}/release-batches\` with the roster and \`promotion: { request: <number> }\`, a request already merged included) and record its deploy once its request merged.`,
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
  // owed when the merge was seen; a merge Forge never heard of before this record owes it here
  await oweReleaseTag(run.id, request.mergeCommitSha, 'promotion');
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
