// A release that already happened, written down from its evidence.
//
// `createReleaseBatch` is the normal path and stays it. This one is gated on
// evidence rather than machinery — the application answers, every probe agrees
// on one commit, and that commit is the one the caller claims — so no runner,
// label or job is needed to record a release that shipped (ISS-1129). With no
// probe declared there is nothing to read, and it is recorded `unverified` (ISS-1321).
//
// It does NOT establish per-issue ancestry: that needs a git provider, and
// requiring one would put the coupling straight back. `merged_at` is required
// instead, and the residual is priced on ISS-1129.

import { and, eq, inArray } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import {
  accountActor,
  claimIssuesForRelease,
  releaseRunClaims,
  TransitionError,
  transitionIssueStatus,
} from '../issues/index.js';
import { logger } from '../observability/logger.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/index.js';
import { collectReleaseBlockers } from './blockers.js';
import { closeVerification, type ReleaseVerification } from './channel.js';
import { claimConflictAt, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { blockerRefusal, notVerifiedRefusal, reasonOf, releaseBlockedRefusal } from './refuse.js';
import { type ServingNowOutcome, verifyServingNow } from './verify.js';

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
  /** What every probe agreed the deployment is serving; `null` where none was declared. */
  identity: string | null;
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

/** The account, as the issue itself will carry it. */
function issueNote(args: {
  commit: string;
  identity: string | null;
  account: string;
  providerRef: string | null;
}): string {
  const handle = args.providerRef ? ` The provider's handle on it: \`${args.providerRef}\`.` : '';
  const read =
    args.identity === null
      ? '- **not verified**: this project declares no live verify probe, so nothing read the deployment and only the account below says this commit is serving\n\n'
      : `- deployment identity read back from the live probes: \`${args.identity}\`\n\n`;
  const how =
    args.identity === null
      ? 'Released outside a release batch, and recorded on the account of whoever released it.'
      : 'Released outside a release batch, and recorded from what production is serving.';
  return `${how}\n\n- commit claimed: \`${args.commit}\`\n${read}${args.account}${handle}`;
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

  // ONE pass before anything refuses, so probes, notes and merges arrive together (ISS-1127).
  const report = await collectReleaseBlockers(projectId, {
    issueIds: args.issueIds,
    door: 'record',
  });
  if (!report.projectExists) throw blockerRefusal('NO_RELEASE_GATE');
  const refusal = releaseBlockedRefusal(report, args.issueIds);
  if (refusal) throw refusal;
  // Every id is now an issue at this project's gate, so its lower-case spelling is the row's own.
  const issueIds = args.issueIds.map((id) => id.toLowerCase());

  const gateStatus = RELEASE_GATE_STATUS;
  // Taken from the report rather than read again: a second read would refuse in its own order
  // (ISS-1127). A refused declaration is already the report's blocker, so this cannot throw.
  const verification = closeVerification(report.channels ?? []);
  const roster = await admissibleIssues(projectId, issueIds);

  let outcome: Extract<ServingNowOutcome, { ok: true }> | null = null;
  if (verification.kind === 'probed') {
    const read = await verifyServingNow({ cfg: verification.cfg, expected: commit });
    if (!read.ok) throw notVerifiedRefusal(read.reason, read.live);
    outcome = read;
  }
  const identity = outcome?.identity ?? null;

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
    },
  });

  const claimed = await claimIssuesForRelease({ projectId, issueIds, gateStatus, runId: run.id });

  if (claimed.length !== issueIds.length) {
    await closeRunIfOneShot(run.id, 'cancelled');
    throw await claimConflictAt(projectId, gateStatus, issueIds, claimed);
  }

  await writeLedger(run.id, { commit, outcome, account, providerRef });

  const note = issueNote({ commit, identity, account, providerRef });
  const closed: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const issue of roster) {
    try {
      await postIssueNotice({ issueId: issue.id, authorId: userId, body: note });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, runId: run.id }, 'release-record: comment failed');
      // With no probe the note is the issue's only word that nothing verified it, so no close.
      if (!outcome) {
        failed.push({
          id: issue.id,
          reason: `its not-verified note could not be written: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }
    try {
      await transitionIssueStatus(
        { id: issue.id, projectId, status: gateStatus, reopenCount: 0 },
        'closed',
        await accountActor(userId),
        { reason: account },
      );
      closed.push(issue.id);
    } catch (err) {
      if (err instanceof TransitionError && err.code === 'NO_OP') {
        closed.push(issue.id);
      } else {
        logger.warn({ err, issueId: issue.id, runId: run.id }, 'release-record: could not close');
        failed.push({ id: issue.id, reason: reasonOf(err) });
      }
    }
  }

  // The claim column is the LOCK this write holds, never the index onto what
  // the record carried — `metadata.issues` is that, and it survives. Leaving a
  // claim behind on an issue that could not close would wedge it out of every
  // future batch, which claims only where the column is null. `finishReleaseBatch`
  // clears it the same way and for the same reason.
  await releaseRunClaims(run.id);

  await closeRunIfOneShot(run.id, failed.length > 0 ? 'failed' : 'completed');

  return {
    runId: run.id,
    commit,
    identity,
    readings: outcome?.readings ?? [],
    verification: verification.kind,
    closed,
    failed,
    issues: roster,
  };
}

/** The ledger row: the intent, the account, and what the probes said — or that none was read. */
async function writeLedger(
  runId: string,
  args: {
    commit: string;
    outcome: Extract<ServingNowOutcome, { ok: true }> | null;
    account: string;
    providerRef: string | null;
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
    health: outcome ? 'up' : null,
    identity: outcome?.identity ?? null,
    readings: outcome?.readings ?? [],
    verdict: outcome ? 'ok' : 'unverified',
    verdictReason: outcome
      ? `every probe agrees the deployment is serving ${outcome.identity}, which is the commit this record claims`
      : 'this project declares no live verify probe, so nothing read the deployment and only the account says this commit is serving',
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
  verification: ReleaseVerification;
  issues: RecordedIssue[];
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
    verification: meta.verification === 'unverified' ? 'unverified' : 'probed',
    issues: Array.isArray(meta.issues) ? (meta.issues as RecordedIssue[]) : [],
  };
}
