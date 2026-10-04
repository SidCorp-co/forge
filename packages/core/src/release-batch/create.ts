// create: opens a system run, atomically claims N gate-status issues, marks each at its `release`
// step, enqueues one release_batch job. Finish and abort end the run (finish.ts, abort.ts).

import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { activeIssuePrefix, claimIssuesForRelease, setWorkStep } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { isRefusal } from '../lib/refusal.js';
import { logger } from '../observability/logger.js';
import type { OneShotRunSpec } from '../pipeline/index.js';
import { closeRunIfOneShot, insertAndEnqueueJob, insertOneShotRun } from '../pipeline/index.js';
import { collectReleaseBlockers } from './blockers.js';
import { closeVerification, type ReleaseVerification, resolveReleasePlan } from './channel.js';
import { claimConflictAt } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { RELEASE_BATCH_SKILL, releaseBranches } from './plan.js';
import { buildReleaseBatchPrompt } from './prompt.js';
import { blockerRefusal, refuseRelease, releaseBlockedRefusal } from './refuse.js';
import { recoverStrandedReleasing } from './releasing-recovery.js';
import { RELEASE_UNSTARTED_DEADLINE_MS } from './unstarted-recovery.js';
import { liveCarriesRoster, readLiveCommit } from './verify.js';
import { cutReleaseVersion } from './version-store.js';

interface CreateReleaseBatchArgs {
  projectId: string;
  issueIds: string[];
  userId: string;
  /**
   * The version of a FAILED release being cut again. Raises the patch digit instead of the minor;
   * refused by name unless it names this project's highest release and that release never shipped.
   */
  recutOf?: string | undefined;
}

export interface CreateReleaseBatchResult {
  runId: string;
  jobId: string;
  issueIds: string[];
  gateStatus: IssueStatus;
  /** The version this release cut. Its identity from the instant its row existed. */
  version: string;
  /** When this batch must have an owner, or it is cancelled and its roster handed back. */
  ownerDeadlineAt: string;
  /**
   * Whether what was already serving when this batch opened carries a roster issue's merge — so
   * this release shipped before the batch recording it existed, and its finish will be earned by
   * identity rather than by a transition. Said here and not at the fifth finish (ISS-1199).
   */
  openedAfterRelease: boolean;
  /** `unverified` where production declares no source probe, which every issue it closes says. */
  verification: ReleaseVerification;
}

/** The blocker report, and the roster's ids in the row's own spelling — or the door's refusal. */
async function admitRoster(projectId: string, named: string[]) {
  // ISS-1127 — one enumerator, and this door refuses with every reason it found, the first first.
  const report = await collectReleaseBlockers(projectId, {
    issueIds: named,
    door: 'batch',
  });
  if (!report.projectExists) throw blockerRefusal('NO_RELEASE_GATE');
  const refusal = releaseBlockedRefusal(report);
  if (refusal) throw refusal;
  // Every id is now an issue at this project's gate, so its lower-case spelling is the row's own.
  const issueIds = named.map((id) => id.toLowerCase());
  // After the report, so every project reason outranks it. An empty gate is
  // already `RELEASE_ROSTER_EMPTY` above; reaching here, issues are waiting and
  // this call named none of them, which is the caller's list to fix.
  if (issueIds.length === 0) {
    throw refuseRelease(
      'RELEASE_ISSUES_UNNAMED',
      `This call names no issue to release, and issues are waiting at the release gate. Send the ids GET /api/projects/${projectId}/release-batches/roster lists, oldest merge first, at most ${RELEASE_ROSTER_LIMIT} in one release.`,
      '/issueIds',
    );
  }

  return { report, issueIds };
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
 * The release row and its version in ONE transaction, then the roster claimed onto it. Cutting the
 * number after the row committed would leave a window in which a release row has no identity; a
 * roster another caller claimed first cancels the row and refuses by name.
 */
async function openClaimedRun(args: {
  projectId: string;
  issueIds: string[];
  recutOf: string | undefined;
  metadata: Record<string, unknown>;
}) {
  const { projectId, issueIds, recutOf, metadata } = args;
  const runSpec: OneShotRunSpec = { projectId, kind: 'system', metadata };
  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, runSpec);
    const cut = await cutReleaseVersion(tx, { runId: row.id, projectId, recutOf });
    return { run: row, version: cut };
  });
  const gateStatus = RELEASE_GATE_STATUS;
  const claimed = await claimIssuesForRelease({ projectId, issueIds, gateStatus, runId: run.id });
  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw await claimConflictAt(projectId, gateStatus, issueIds, claimed);
  }
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

export async function createReleaseBatch(
  args: CreateReleaseBatchArgs,
): Promise<CreateReleaseBatchResult> {
  const { projectId, userId, recutOf } = args;

  const { report, issueIds } = await admitRoster(projectId, args.issueIds);

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
    recutOf,
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
    },
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
