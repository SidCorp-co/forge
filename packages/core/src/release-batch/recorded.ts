// A release that already happened, written down on its agent's word.
//
// `createReleaseBatch` is the path where Forge deploys and reads the deploy back. This one is the
// record of a release a door outside it performed — a binding deployed by hand, a storefront, a
// production deployed outside Forge by the door it names (ISS-851): the agent names the issues, the
// version it released and its account, and the roster closes. Forge reads no commit and asks no
// probe (owner ruling 2026-11-01, `release-is-the-agents-record`); a sha the agent sends is kept as
// its evidence, never compared. What stays kernel: only the issues named close, each waiting at the
// gate on this project, and each close carries the version and the account.

import type { ReleaseShippedFailing } from '@forge/contracts/releases';
import { and, eq, inArray } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { releaseAttempts } from '../db/schema-release-ledger.js';
import { accountActor, releaseRunClaims, transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import { closeRunIfOneShot, insertOneShotRun, stampReleaseShipped } from '../pipeline/index.js';
import { admitRoster } from './blockers.js';
import type { RecordedVerification } from './channel.js';
import { claimRoster, RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { carryNaming } from './naming.js';
import { RECORDED_VERIFICATIONS } from './plan.js';
import { askProviderLiveGate, type GateOffRecord } from './provider-live.js';
import { reasonOf } from './refuse.js';
import { oweReleaseTag } from './release-tag.js';
import { takeGivenVersion } from './version-store.js';

/** What a release its agent recorded stores (owner, 2026-11-01): the agent's record is the release. */
export const RECORDED_VERIFICATION = 'recorded' as const;

/** The one ledger key a recorded release writes under. */
const RECORD_ATTEMPT_KEY = 'release-record';

export interface RecordPerformedReleaseArgs {
  projectId: string;
  issueIds: string[];
  /** The release the agent says it shipped, in the stored shape (`version-store.ts:givenReleaseVersion`);
   *  absent on a landing, which Forge versions. */
  version?: string | undefined;
  /** A sha the agent carries as evidence; never required on a release and never compared. A landing's
   *  is its identity on the branch. */
  commit?: string | undefined;
  /** How the release was performed, and why it was not a batch. */
  account: string;
  /** The provider's own handle on the act — a deployment uuid, a tag. Never the evidence. */
  providerRef?: string | undefined;
  /** Under release mode `none`, the branch the commit is on; the declared landing branch where absent. */
  branch?: string | undefined;
  userId: string;
}

/** One issue as the record found it, so the claim stays checkable afterwards. */
export interface RecordedIssue {
  id: string;
  mergedAt: string | null;
  mergedCommitSha: string | null;
}

export interface RecordPerformedReleaseResult {
  runId: string;
  /** The sha the caller carried, normalized by nothing; null where it sent none. */
  commit: string | null;
  /** A landing's commit; null on a release recorded on its agent's word, where nothing was read. */
  identity: string | null;
  readings: string[];
  verification: RecordedVerification;
  /** The working branch a landing record names; absent on a release production serves. */
  branch?: string;
  /** The version the agent recorded; on a landing, the one Forge cut (`cutReleaseVersion`). */
  version: string;
  closed: string[];
  failed: Array<{ id: string; reason: string }>;
  issues: RecordedIssue[];
  /** A landing's criteria that shipped failing, said whole where any did; null where none did. */
  shippedFailing?: ReleaseShippedFailing | null;
}

/** Every issue this record may close, read once and refused by name. */
export async function admissibleIssues(
  projectId: string,
  issueIds: string[],
): Promise<RecordedIssue[]> {
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
  version: string;
  commit: string | null;
  account: string;
  providerRef: string | null;
}): string {
  const sha = args.commit ? `, at \`${args.commit}\` as its agent recorded it` : '';
  const handle = args.providerRef ? ` The provider's handle on it: \`${args.providerRef}\`.` : '';
  return `Released as ${args.version}${sha}, recorded by the agent that performed it.\n\n${args.account}${handle}`;
}

/** Each recorded issue told how it shipped, then closed; one that will not close is named. */
export async function closeRecorded(
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

/**
 * Record a release that has already happened, on its agent's word, and close what it carried. The
 * roster is admitted before anything is written, so a record refused leaves every issue where it stood.
 */
export async function recordPerformedRelease(
  args: RecordPerformedReleaseArgs & { version: string },
): Promise<RecordPerformedReleaseResult> {
  const { projectId, account, userId } = args;
  const commit = args.commit ?? null;
  const providerRef = args.providerRef ?? null;
  const verification: RecordedVerification = RECORDED_VERIFICATION;

  const { issueIds } = await admitRoster(projectId, args.issueIds, 'record');
  const roster = await admissibleIssues(projectId, issueIds);
  const providerLiveGateOff = await askProviderLiveGate(issueIds);
  const readings = [`recorded by its agent as ${args.version}${commit ? ` at ${commit}` : ''}`];

  const { run, version } = await db.transaction(async (tx) => {
    const row = await insertOneShotRun(tx, {
      projectId,
      kind: 'system',
      metadata: {
        source: RELEASE_RECORD_SOURCE,
        gateStatus: RELEASE_GATE_STATUS,
        issueIds,
        commit,
        identity: null,
        verification,
        providerRef,
        recordedBy: userId,
        issues: roster,
        ...(providerLiveGateOff.length ? { providerLiveGateOff } : {}),
      },
    });
    const given = await takeGivenVersion(tx, { runId: row.id, projectId, version: args.version });
    await carryNaming(tx, {
      projectId,
      version: given,
      runId: row.id,
      given: null,
      by: userId,
      roster: issueIds,
    });
    await emitEvent(tx, 'release.cut', { projectId, runId: row.id, version: given });
    // a sha the agent named is the cut's commit (REQ-63 BC-13): its tag is owed in the same unit
    if (commit) await oweReleaseTag(row.id, commit, 'record', tx);
    return { run: row, version: given };
  });

  await claimRoster(projectId, issueIds, run.id);

  await writeLedger(run.id, {
    commit,
    outcome: { identity: null, readings, health: null },
    account,
    providerRef,
    how: verification,
    version,
  });

  const note = issueNote({ version, commit, account, providerRef });
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
  // the agent recorded the release as shipped: a record that closed what it claimed shipped
  if (failed.length === 0) await stampReleaseShipped(run.id);

  return {
    runId: run.id,
    version,
    commit,
    identity: null,
    readings,
    verification,
    closed,
    failed,
    issues: roster,
  };
}

/** The ledger row: the intent, the account, and what was read — on an agent's record, nothing. */
export async function writeLedger(
  runId: string,
  args: {
    commit: string | null;
    outcome: { identity: string | null; readings: string[]; health: 'up' | null };
    account: string;
    providerRef: string | null;
    how: 'landed' | typeof RECORDED_VERIFICATION;
    /** The working branch a landing landed on. */
    branch?: string;
    /** The version an agent's record names. */
    version?: string;
  },
): Promise<void> {
  const { outcome } = args;
  const reasons: Record<'landed' | typeof RECORDED_VERIFICATION, string> = {
    recorded: `recorded by its agent as ${args.version}`,
    landed: `landed on ${args.branch} as ${args.version}, recorded by the agent; no environment is declared, so nothing was deployed`,
  };
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
    verdict: args.how === 'landed' ? 'ok' : RECORDED_VERIFICATION,
    verdictReason: reasons[args.how],
    settledAt: new Date(),
  });
}

interface ReleaseRecordView {
  runId: string;
  projectId: string;
  recordedAt: string | null;
  commit: string | null;
  identity: string | null;
  /** The working branch a landing record landed on; null on a release production serves. */
  branch: string | null;
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
    branch: typeof meta.branch === 'string' ? meta.branch : null,
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
