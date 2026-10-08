// A release that already happened, written down from its evidence.
//
// `createReleaseBatch` is the normal path and stays it. This one is gated on
// evidence rather than machinery — the application answers, every probe agrees
// on one commit, and that commit is the one the caller claims — so no runner,
// label or job is needed to record a release that shipped (ISS-1129). With no
// source probe declared, production's deployment record has to name the commit;
// where nothing can show it, the record is refused `RELEASE_NOT_VERIFIED`.
//
// It does NOT establish per-issue ancestry: that needs a git provider, and
// requiring one would put the coupling straight back. `merged_at` is required
// instead, and the residual is priced on ISS-1129.

import { and, eq, inArray } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { accountActor, releaseRunClaims, transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/index.js';
import { admitRoster } from './blockers.js';
import {
  type CloseVerification,
  closeVerification,
  type RecordedVerification,
  type ReleaseVerification,
} from './channel.js';
import { claimRoster, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { verifyByDeploymentRecord } from './deployment-verify.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { RECORDED_VERIFICATIONS } from './plan.js';
import { askProviderLiveGate, type GateOffRecord } from './provider-live.js';
import { verifyByProviderRecord } from './provider-verify.js';
import { notVerifiedRefusal, providerNotVerifiedRefusal, reasonOf } from './refuse.js';
import { verifyServingNow } from './verify.js';

/** The one ledger key a recorded release writes under. */
const RECORD_ATTEMPT_KEY = 'release-record';

interface RecordPerformedReleaseArgs {
  projectId: string;
  issueIds: string[];
  /** The whole sha the caller says production is serving. */
  commit: string;
  /** How the release was performed, and why it was not a batch. */
  account: string;
  /** The provider's own handle on the act — a deployment uuid, a tag. Never the evidence. */
  providerRef?: string | undefined;
  userId: string;
}

/** One issue as the record found it, so the claim stays checkable afterwards. */
interface RecordedIssue {
  id: string;
  mergedAt: string | null;
  mergedCommitSha: string | null;
}

interface RecordPerformedReleaseResult {
  runId: string;
  /** What the caller claimed, normalized by nothing. */
  commit: string;
  /** What the probes, or the deployment record, agreed production is serving. */
  identity: string;
  readings: string[];
  verification: ReleaseVerification;
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
  issues: RecordedIssue[];
}

/** Every issue this record may close, read once and refused by name. */
async function admissibleIssues(projectId: string, issueIds: string[]): Promise<RecordedIssue[]> {
  const rows = await db
    .select({ id: issues.id, mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds)));

  return rows.map((r) => ({
    id: r.id,
    mergedAt: r.mergedAt ? r.mergedAt.toISOString() : null,
    mergedCommitSha: r.mergedCommitSha,
  }));
}

const SOURCE_OF: Record<ReleaseVerification, string> = {
  probed: 'the live probes',
  provider: 'what the storefront provider publishes',
  deployment: "production's deployment record",
};

/** The account, as the issue itself will carry it. */
function issueNote(args: {
  commit: string;
  identity: string;
  how: ReleaseVerification;
  account: string;
  providerRef: string | null;
}): string {
  const handle = args.providerRef ? ` The provider's handle on it: \`${args.providerRef}\`.` : '';
  const source = SOURCE_OF[args.how];
  return `Released outside a release batch, and recorded from what production is serving.\n\n- commit claimed: \`${args.commit}\`\n- deployment identity read back from ${source}: \`${args.identity}\`\n\n${args.account}${handle}`;
}

/** Each recorded issue told how it shipped, then closed; one that will not close is named. */
async function closeRecorded(
  roster: Array<{ id: string }>,
  ctx: {
    projectId: string;
    userId: string;
    account: string;
    note: string;
    runId: string;
  },
): Promise<{ closed: string[]; failed: Array<{ id: string; reason: string }> }> {
  const { projectId, userId, account, note, runId } = ctx;
  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const issue of roster) {
    try {
      await postIssueNotice({
        issueId: issue.id,
        authorId: userId,
        body: note,
        authorsWords: true,
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, runId }, 'release-record: comment failed');
    }
    try {
      await transitionIssueStatus(
        { id: issue.id, projectId, status: RELEASE_GATE_STATUS, reopenCount: 0 },
        'closed',
        await accountActor(userId),
        { reason: account },
      );
      closed.push(issue.id);
    } catch (err) {
      if (isRefusal(err, 'NO_OP')) {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId }, 'release-record: could not close');
        failed.push({ id: issue.id, reason: reasonOf(err) });
      }
    }
  }
  return { closed, failed };
}

/** What production serves, read once by the way this release is proved; refused where it does not
 *  show the claim (the commit, or on a storefront every landing of the issues recorded). */
async function readWhatServes(
  verification: CloseVerification,
  args: { projectId: string; commit: string; issueIds: string[] },
): Promise<{ identity: string; readings: string[] }> {
  if (verification.kind === 'provider') {
    const read = await verifyByProviderRecord({ ...args, channel: verification.channel });
    if (!read.ok) throw providerNotVerifiedRefusal(read.reason, read.mismatches);
    return read;
  }
  const read =
    verification.kind === 'probed'
      ? await verifyServingNow({ cfg: verification.cfg, expected: args.commit })
      : await verifyByDeploymentRecord(args.projectId, args.commit);
  if (!read.ok) throw notVerifiedRefusal(read.reason, read.live);
  return read;
}

/**
 * Record a release that has already happened, and close what it carried. The
 * probes are read BEFORE anything is claimed, so a record that cannot be earned
 * leaves every issue where it stood.
 */
export async function recordPerformedRelease(
  args: RecordPerformedReleaseArgs,
): Promise<RecordPerformedReleaseResult> {
  const { projectId, commit, account, userId } = args;
  const providerRef = args.providerRef ?? null;

  const { report, issueIds } = await admitRoster(projectId, args.issueIds, 'record');

  const gateStatus = RELEASE_GATE_STATUS;
  // Taken from the report rather than read again: a second read would refuse in its own order
  // (ISS-1127). A refused declaration is already the report's blocker, so this cannot throw.
  const verification = closeVerification(report.channels ?? []);
  const roster = await admissibleIssues(projectId, issueIds);
  const providerLiveGateOff = await askProviderLiveGate(issueIds);

  const read = await readWhatServes(verification, { projectId, commit, issueIds });
  // The deployment record says what was built, not that it answers, so only a probe reads health.
  const outcome = {
    identity: read.identity,
    readings: read.readings,
    health: verification.kind === 'probed' ? ('up' as const) : null,
  };
  const identity = outcome.identity;

  const run = await openOneShotRun({
    projectId,
    kind: 'system',
    metadata: {
      source: RELEASE_RECORD_SOURCE,
      gateStatus,
      issueIds,
      commit,
      identity,
      verification: verification.kind,
      providerRef,
      recordedBy: userId,
      issues: roster,
      ...(providerLiveGateOff.length ? { providerLiveGateOff } : {}),
    },
  });

  await claimRoster(projectId, issueIds, run.id);

  await writeLedger(run.id, { commit, outcome, account, providerRef, how: verification.kind });

  const note = issueNote({ commit, identity, how: verification.kind, account, providerRef });
  const { closed, failed } = await closeRecorded(roster, {
    projectId,
    userId,
    account,
    note,
    runId: run.id,
  });

  // The claim column is the LOCK this write holds, never the index onto what
  // the record carried — `metadata.issues` is that, and it survives. Leaving a
  // claim behind on an issue that could not close would wedge it out of every
  // future batch, which claims only where the column is null. `finishReleaseBatch`
  // clears it the same way and for the same reason.
  await releaseRunClaims(run.id);

  await closeRunIfOneShot(run.id, failed.length > 0 ? 'failed' : 'completed', {
    code: 'release_record_incomplete',
    detail: `${failed.length} of the recorded issues would not close: ${failed
      .map((f) => `${f.id} (${f.reason})`)
      .join('; ')}`,
  });

  return {
    runId: run.id,
    commit,
    identity,
    readings: outcome.readings,
    verification: verification.kind,
    closed,
    failed,
    issues: roster,
  };
}

/** The ledger row: the intent, the account, and what the probes or the deployment record said. */
async function writeLedger(
  runId: string,
  args: {
    commit: string;
    outcome: { identity: string; readings: string[]; health: 'up' | null };
    account: string;
    providerRef: string | null;
    how: ReleaseVerification;
  },
): Promise<void> {
  const { outcome } = args;
  await db.insert(releaseAttempts).values({
    runId,
    stage: 'verify',
    idempotencyKey: RECORD_ATTEMPT_KEY,
    commit: args.commit,
    providerRef: args.providerRef,
    account: args.account,
    health: outcome.health,
    identity: outcome.identity,
    readings: outcome.readings,
    verdict: 'ok',
    verdictReason:
      args.how === 'provider'
        ? `what the storefront provider publishes (${outcome.identity}) carries every landing of the issues this record names`
        : `what production serves reads ${outcome.identity}, which is the commit this record claims`,
    settledAt: new Date(),
  });
}

interface ReleaseRecordView {
  runId: string;
  projectId: string;
  recordedAt: string | null;
  commit: string | null;
  identity: string | null;
  providerRef: string | null;
  account: string | null;
  readings: string[];
  /** Records written before ISS-1321 could only be `probed`: that door refused a project with none. */
  verification: RecordedVerification;
  issues: RecordedIssue[];
  /** The contract waits this release passed only because the ecosystem turned the provider-live gate off. */
  providerLiveGateOff: GateOffRecord;
}

/**
 * One recorded release, read back.
 *
 * `null` for a run this project does not own, and for a batch run — a batch is
 * read through its own endpoints, and answering for one here would make
 * "how was this released" unanswerable from the reply.
 */
export async function readReleaseRecord(
  projectId: string,
  runId: string,
): Promise<ReleaseRecordView | null> {
  const [run] = await db
    .select({
      id: pipelineRuns.id,
      projectId: pipelineRuns.projectId,
      startedAt: pipelineRuns.startedAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run || run.projectId !== projectId) return null;

  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== RELEASE_RECORD_SOURCE) return null;

  const [attempt] = await db
    .select({
      account: releaseAttempts.account,
      identity: releaseAttempts.identity,
      readings: releaseAttempts.readings,
      providerRef: releaseAttempts.providerRef,
    })
    .from(releaseAttempts)
    .where(
      and(eq(releaseAttempts.runId, runId), eq(releaseAttempts.idempotencyKey, RECORD_ATTEMPT_KEY)),
    )
    .limit(1);

  return {
    runId: run.id,
    projectId: run.projectId,
    recordedAt: run.startedAt ? run.startedAt.toISOString() : null,
    commit: typeof meta.commit === 'string' ? meta.commit : null,
    identity: attempt?.identity ?? (typeof meta.identity === 'string' ? meta.identity : null),
    providerRef: attempt?.providerRef ?? null,
    account: attempt?.account ?? null,
    readings: attempt?.readings ?? [],
    verification: (RECORDED_VERIFICATIONS as readonly unknown[]).includes(meta.verification)
      ? (meta.verification as RecordedVerification)
      : 'probed',
    issues: Array.isArray(meta.issues) ? (meta.issues as RecordedIssue[]) : [],
    providerLiveGateOff: Array.isArray(meta.providerLiveGateOff)
      ? (meta.providerLiveGateOff as GateOffRecord)
      : [],
  };
}
