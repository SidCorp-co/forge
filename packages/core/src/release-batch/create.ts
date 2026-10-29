// create: opens a system run, atomically claims N gate-status issues, marks each at its `release`
// step, enqueues one release_batch job. Finish and abort end the run (finish.ts, abort.ts).

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import {
  activeIssuePrefix,
  designOnlyMarkSql,
  heldByEndedReleaseIds,
  recordIssueMerge,
  setWorkStep,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import type { OneShotRunSpec } from '../pipeline/index.js';
import { closeRunIfOneShot, insertAndEnqueueJob, insertOneShotRun } from '../pipeline/index.js';
import { projectCreatorOf } from '../projects/index.js';
import { requestApproval } from './approvals.js';
import { admitRoster } from './blockers.js';
import { label, mergeOrderOf, openChangeRequestsOf } from './change-request-roster.js';
import { closeVerification, type ReleaseVerification, resolveReleasePlan } from './channel.js';
import { claimRoster } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { landedOnTargetOf } from './landed-on-target.js';
import { carryNaming } from './naming.js';
import { RELEASE_BATCH_SKILL, releaseBranches } from './plan.js';
import { cutPromotionRelease } from './promotion-release.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { askProviderLiveGate } from './provider-live.js';
import { blockerRefusal, refuseRelease } from './refuse.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { closeShippedEarlier, type ShippedEarlierDeps } from './shipped-earlier.js';
import { RELEASE_UNSTARTED_DEADLINE_MS } from './unstarted-recovery.js';
import { liveCarriesRoster, readLiveCommit } from './verify.js';
import { cutReleaseVersion } from './version-store.js';

interface CreateReleaseBatchArgs {
  projectId: string;
  issueIds: string[];
  userId: string;
  /** The release's name and summary, when the cut writes them (REQ-40 BC-14). */
  naming?: ReleaseNaming | null;
  /** The order a release that merges change requests merges them in, by number (REQ-63). */
  changeRequests?: number[] | undefined;
}

export interface CreateReleaseBatchResult {
  runId: string;
  /** The release job; null on a release that merges change requests, which runs no job. */
  jobId: string | null;
  issueIds: string[];
  gateStatus: IssueStatus;
  /** The version this release cut. Its identity from the instant its row existed. */
  version: string;
  /** When this batch must have an owner, or it is cancelled and its roster handed back; null where
   *  it runs no job and waits on its approval instead. */
  ownerDeadlineAt: string | null;
  /**
   * Whether what was already serving when this batch opened carries a roster issue's merge — so
   * this release shipped before the batch recording it existed, and its finish will be earned by
   * identity rather than by a transition. Said here and not at the fifth finish (ISS-1199).
   */
  openedAfterRelease: boolean;
  /** `deployment` where production declares no source probe: its deployment record must name the commit;
   *  `provider` where the work lives on a storefront whose provider reports what it publishes. */
  verification: ReleaseVerification | 'merged';
  /** The change requests the release merges, in its order; absent on a release that deploys. */
  changeRequests?: { number: number; label: string; headSha: string }[];
}

/** The batch door's admission, and a call naming no issue while issues wait refused by name. */
async function admitBatch(projectId: string, named: string[]) {
  const admitted = await admitRoster(projectId, named, 'batch');
  // After the report, so every project reason outranks it. An empty gate is already
  // `RELEASE_ROSTER_EMPTY` there; reaching here, issues are waiting and this call named none.
  if (admitted.issueIds.length === 0) {
    throw refuseRelease(
      'RELEASE_ISSUES_UNNAMED',
      `This call names no issue to release, and issues are waiting at the release gate. Send the ids GET /api/projects/${projectId}/release-batches/roster lists, oldest merge first, at most ${RELEASE_ROSTER_LIMIT} in one release.`,
      '/issueIds',
    );
  }
  return admitted;
}

/** ISS-54: a release run holding the issue is a step inside `awaiting_release`, not a status. */
async function markReleaseSteps(issueIds: string[], runId: string): Promise<void> {
  for (const id of issueIds) {
    try {
      await setWorkStep(db, id, 'release');
    } catch (err) {
      logger.warn({ err, issueId: id, runId }, 'release-batch: could not mark the release step');
    }
  }
}

/** The release job, or — where another batch holds the slot — this run handed back and refused. */
async function enqueueReleaseJob(args: {
  projectId: string;
  userId: string;
  runId: string;
  issueIds: string[];
  promptString: string;
}): Promise<string> {
  const { projectId, userId, runId, issueIds, promptString } = args;
  try {
    const result = await insertAndEnqueueJob({
      projectId,
      issueId: null,
      pipelineRunId: runId,
      createdBy: userId,
      type: 'release_batch',
      skillName: RELEASE_BATCH_SKILL,
      promptString,
      payloadExtras: {
        releaseBatch: true,
        gateStatus: RELEASE_GATE_STATUS,
        issueIds,
        timeoutSeconds: 3600,
      },
    });
    return result.jobId;
  } catch (err) {
    if (isRefusal(err, 'ACTIVE_JOB_CONFLICT')) {
      await recoverStrandedReleasing(runId, {
        reason: 'another batch was already in flight, so this one never started',
        actorUserId: userId,
      });
      await closeRunIfOneShot(runId, 'cancelled');
      throw blockerRefusal('BATCH_IN_FLIGHT');
    }
    throw err;
  }
}

/**
 * The release row, its version and its name in ONE transaction, then the roster claimed onto it. Cutting the
 * number after the row committed would leave a window in which a release row has no identity; a
 * roster another caller claimed first cancels the row and refuses by name.
 */
export async function openClaimedRun(args: {
  projectId: string;
  issueIds: string[];
  metadata: Record<string, unknown>;
  naming: ReleaseNaming | null;
  userId: string;
}) {
  const { projectId, issueIds, metadata } = args;
  const runSpec: OneShotRunSpec = { projectId, kind: 'system', metadata };
  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, runSpec);
    const cut = await cutReleaseVersion(tx, { runId: row.id, projectId, issueIds });
    await carryNaming(tx, {
      projectId,
      version: cut,
      runId: row.id,
      given: args.naming,
      by: args.userId,
      roster: issueIds,
    });
    // every cut is named (REQ-40 BC-14): one nobody named is drafted off this event, never left bare
    await emitEvent(tx, 'release.cut', { projectId, runId: row.id, version: cut });
    return { run: row, version: cut };
  });
  const claimed = await claimRoster(projectId, issueIds, run.id);
  await markReleaseSteps(
    claimed.map((r) => r.id),
    run.id,
  );
  return { run, version };
}

/** Whether a box eligible to release carries the declared label; the pool takes it otherwise. */
function runnerPreferenceMet(
  projectId: string,
  report: { warnings: { code: string }[] },
  releaseRunnerLabel: string | null,
): boolean {
  const met = report.warnings.every((w) => w.code !== 'RELEASE_RUNNER_PREFERENCE_UNMET');
  if (!met) {
    logger.warn(
      { projectId, releaseRunnerLabel },
      'release-batch: no box eligible to release carries the declared label, so this batch goes to the pool this project has',
    );
  }
  return met;
}

/**
 * The named ids less those an earlier release already shipped, which are closed against it here.
 * The project's rows a release that ended unshipped still claims are closed here too where a
 * shipped release holds their commit; they are never this cut's to carry. A call whose every
 * named id was already shipped has nothing to release: refused by name with the versions.
 */
async function withoutShippedEarlier(
  projectId: string,
  named: string[],
  userId: string,
  deps: ShippedEarlierDeps,
): Promise<string[]> {
  const held = await heldByEndedReleaseIds(projectId, RELEASE_GATE_STATUS);
  const earlier = await closeShippedEarlier(
    { projectId, issueIds: [...named, ...held.filter((id) => !named.includes(id))], userId },
    deps,
  );
  const shipped = new Set(earlier.closed.map((c) => c.issueId));
  const ofNamed = earlier.closed.filter((c) => named.includes(c.issueId));
  if (ofNamed.length === 0) return named;
  const rest = named.filter((id) => !shipped.has(id));
  if (rest.length === 0) {
    const where = ofNamed.map((c) => `${c.issueId} in ${c.version}`).join(', ');
    throw refuseRelease(
      'RELEASE_ALL_SHIPPED_EARLIER',
      `Every issue this call names was already shipped by an earlier release, so there is nothing to release: ${where}. Each is now closed against that release; no new release was cut.`,
      '/issueIds',
    );
  }
  return rest;
}

/**
 * The named ids less the design-only ones: a design ships nothing a release carries, so it rides no
 * roster and closes on its approved revisions instead (REQ-45 BC-4). A call naming only design-only
 * issues is refused by name, so a cut never opens with nothing to release (dev.210).
 */
async function withoutDesignOnly(projectId: string, named: string[]): Promise<string[]> {
  if (named.length === 0) return named;
  const rows = await db
    .select({ id: issues.id, key: issues.issSeq })
    .from(issues)
    .where(and(inArray(issues.id, named), sql`${designOnlyMarkSql(sql`${issues}`)}`));
  if (rows.length === 0) return named;
  const skipped = new Set(rows.map((r) => r.id));
  const rest = named.filter((id) => !skipped.has(id));
  if (rest.length > 0) {
    logger.info({ projectId, skipped: [...skipped] }, 'release batch skips design-only issues');
    return rest;
  }
  const prefix = await activeIssuePrefix(projectId);
  const keys = rows.map((r) => (r.key != null ? formatIssueRef(prefix, r.key) : r.id)).join(', ');
  throw refuseRelease(
    'RELEASE_ALL_DESIGN_ONLY',
    `Every issue this call names is design-only (${keys}): its landing is an approved design revision, which a release does not carry, so there is nothing to release. Close each through its \`design_delivered\` edge (move it to \`closed\`) once its revisions are approved; no release was cut.`,
    '/issueIds',
  );
}

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
  deps: ShippedEarlierDeps = {},
): Promise<CreateReleaseBatchResult> {
  const { projectId, userId } = args;

  const code = await withoutDesignOnly(projectId, args.issueIds);
  const named = await withoutShippedEarlier(projectId, code, userId, deps);
  const { report, issueIds } = await admitBatch(projectId, named);
  if (report.declaration?.kind === 'change-requests') {
    return cutChangeRequestRelease({ ...args, issueIds }, report.declaration.defaultBranch);
  }
  if (report.declaration?.kind === 'promotion') {
    return cutPromotionRelease({ ...args, issueIds }, report.declaration, openClaimedRun);
  }
  if (args.changeRequests) {
    throw refuseRelease(
      'RELEASE_CHANGE_REQUEST_ORDER',
      '`changeRequests` orders the merges of a release that ships by merging change requests, and this project does not release that way (`release.changeRequests` is not set): send the cut without it.',
      '/changeRequests',
    );
  }
  const providerLiveGateOff = await askProviderLiveGate(issueIds);

  const gateStatus = RELEASE_GATE_STATUS;
  const plan = await resolveReleasePlan(projectId);
  const preferenceMet = runnerPreferenceMet(projectId, report, plan.releaseRunnerLabel);

  const decl = report.declaration;
  if (decl?.kind !== 'gated') throw blockerRefusal('NO_RELEASE_GATE');
  const { defaultBranch, promotePlanned } = releaseBranches(decl.path);
  const deployPlanned = plan.channels.length > 0;
  const verification = closeVerification(plan.channels);
  const commitBefore =
    verification.kind === 'probed' ? await readLiveCommit(verification.cfg) : null;

  const issueRows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const openedAfterRelease = liveCarriesRoster(
    commitBefore,
    issueRows.map((r) => r.mergedCommitSha),
  );

  const { run, version } = await openClaimedRun({
    projectId,
    issueIds,
    metadata: {
      source: 'release-batch',
      gateStatus,
      issueIds,
      deployPlanned,
      promotePlanned,
      commitBefore,
      openedAfterRelease,
      verification: verification.kind,
      releaseRunner: { label: plan.releaseRunnerLabel, preferenceMet },
      ...(providerLiveGateOff.length ? { providerLiveGateOff } : {}),
    },
    naming: args.naming ?? null,
    userId,
  });

  const batchPrefix = await activeIssuePrefix(projectId);
  const promptString = buildReleaseBatchPrompt({
    runId: run.id,
    projectId,
    defaultBranch,
    path: decl.path,
    plan,
    releaseRunnerPreferenceMet: preferenceMet,
    issues: issueRows.map((r) => ({
      id: r.id,
      displayId: r.issSeq != null ? formatIssueRef(batchPrefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
    })),
  });

  const jobId = await enqueueReleaseJob({
    projectId,
    userId,
    runId: run.id,
    issueIds,
    promptString,
  });

  return {
    runId: run.id,
    jobId,
    issueIds,
    gateStatus,
    version,
    ownerDeadlineAt: new Date(Date.now() + RELEASE_UNSTARTED_DEADLINE_MS).toISOString(),
    openedAfterRelease,
    verification: verification.kind,
  };
}

/**
 * A release that ships by merging change requests (REQ-63): the run, its version and the roster
 * claimed as any cut, the declared merge order kept on the run, and the approval asked at once on
 * the requests' heads. No job runs: the master merges each request once the owner approves. An
 * issue the host already holds on the target branch rides with no request (`alreadyLanded` on the
 * run); a roster of only such issues merges nothing, and its approval settles it
 * (`approval-wake.ts`). Any other issue no request delivers is refused by name.
 */
async function cutChangeRequestRelease(
  args: CreateReleaseBatchArgs,
  branch: string | null,
): Promise<CreateReleaseBatchResult> {
  const { projectId, issueIds, userId } = args;
  const steps = mergeOrderOf(await openChangeRequestsOf(projectId, issueIds), args.changeRequests);
  const merged = new Set(steps.flatMap((s) => s.issueIds.map((id) => id.toLowerCase())));
  const rest = issueIds.filter((id) => !merged.has(id.toLowerCase()));
  const landed = await landedOnTargetOf(projectId, rest);
  const missing = rest.filter((id) => !landed.has(id.toLowerCase()));
  if (missing.length > 0)
    throw blockerRefusal('RELEASE_CHANGE_REQUEST_MISSING', { issueIds: missing });
  const alreadyLanded = [...landed].map(([issueId, on]) => ({ issueId, ...on }));
  await stampHostLandings(projectId, alreadyLanded);
  const last = steps.at(-1);
  const evidenceCommit = last?.headSha ?? alreadyLanded[0]?.commit;
  if (!evidenceCommit) throw blockerRefusal('RELEASE_CHANGE_REQUEST_MISSING', { issueIds });
  const { run, version } = await openClaimedRun({
    projectId,
    issueIds,
    metadata: {
      source: 'release-batch',
      gateStatus: RELEASE_GATE_STATUS,
      issueIds,
      deployPlanned: false,
      promotePlanned: false,
      verification: 'merged',
      changeRequests: steps,
      alreadyLanded,
    },
    naming: args.naming ?? null,
    userId,
  });
  const order = steps.map((s) => label(s)).join(', ');
  const n = alreadyLanded.length;
  const onBranch =
    n === 0
      ? ''
      : ` ${n === 1 ? 'One issue is' : `${n} issues are`} already on it and merge nothing.`;
  const into = branch ? `\`${branch}\`` : 'the working branch';
  await requestApproval({
    projectId,
    runId: run.id,
    userId,
    body: {
      evidence: {
        commit: evidenceCommit,
        reading: (steps.length > 0
          ? `Merges ${order} into ${into}, in this order, once approved.${onBranch}`
          : `Nothing to merge: every issue is already on ${into}. Approving closes them.`
        ).slice(0, 500),
      },
    },
  });
  return {
    runId: run.id,
    jobId: null,
    issueIds,
    gateStatus: RELEASE_GATE_STATUS,
    version,
    ownerDeadlineAt: null,
    openedAfterRelease: false,
    verification: 'merged',
    changeRequests: steps.map((s) => ({
      number: s.number,
      label: label(s),
      headSha: s.headSha,
    })),
  };
}

/**
 * The host landing a cut read on the target branch, written as the host's record of it
 * (`merged_commit_sha`), stamped when the host was read holding it there, as a mark read the same
 * way is (`issues/host-mark.ts`): every reader of "landed", the close among them, reads the host's
 * record, and a box's mark that predates it is not one.
 */
async function stampHostLandings(
  projectId: string,
  landed: ReadonlyArray<{
    issueId: string;
    branch: string;
    commit: string;
    from: 'host-merge' | 'branch';
  }>,
): Promise<void> {
  const read = landed.filter((l) => l.from === 'branch');
  if (read.length === 0) return;
  const owner = await projectCreatorOf(projectId);
  const at = new Date();
  await db.transaction(async (tx) => {
    for (const l of read) {
      await recordIssueMerge(tx, {
        issueId: l.issueId,
        via: 'repository',
        actor: owner ? { type: 'user', id: owner, agency: 'agent' } : null,
        evidence: { kind: 'observed', commitSha: l.commit, mergedAt: at, target: l.branch },
      });
    }
  });
}
