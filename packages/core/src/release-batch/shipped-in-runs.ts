// The shipped-in record two release runs make as their own (ISS-888, owner ruling
// `release-is-the-agents-record`), by the rule and through the close `shipped-in.ts` holds an agent's
// record to: a finish records the late-marked landings it holds as shipped in the version it ships,
// and an abort over a roster an earlier release already shipped records it there, or holds it for the
// agent naming that record, never for a person.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { markedCommitsOf, type TransitionActor } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal, refusalCodeOf } from '../lib/refusal.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { writeReleaseHolds } from './hold.js';
import { waitingIssueIds } from './queries.js';
import { FENCE_LOST, reasonOf } from './refuse.js';
import {
  abortShippedInHold,
  heldBy,
  readShippedInRow,
  recordShippedIn,
  refuseCutBeforeLanding,
  type ShippingRelease,
  shipInto,
  shippedInHold,
} from './shipped-in.js';
import { shippedReleaseRuns } from './shipped-releases.js';

/** What a release's finish did with the waiting issues it left unclaimed whose landing it holds. */
export interface LateMarkOutcome {
  /** Recorded as shipped in this release and closed into it. */
  claimed: string[];
  /** Left at the gate, each held for its agent naming the record to make, and why. */
  leftOut: Array<{ issueId: string; code: string; reason: string; owes: 'agent' }>;
}

const authorOf = (actor: TransitionActor) => (actor.type === 'user' ? actor.id : actor.ownerId);

/**
 * ISS-888, at a release's finish: every issue waiting unclaimed at the gate whose landing this
 * release holds by the rule a shipped-in record is held to (landed no later than its cut), and whose
 * merged mark came only after the cut, so the cut's roster never named it, is recorded as shipped in
 * the version this release ships and closed into it. The finish is the release run's record (owner
 * ruling `release-is-the-agents-record`); Forge reads no commit and names no other version. One it
 * cannot close is held for its agent naming the record to make, and named on the run.
 */
export async function claimMarkedLate(
  runId: string,
  actor: TransitionActor,
): Promise<LateMarkOutcome> {
  const outcome: LateMarkOutcome = { claimed: [], leftOut: [] };
  const [run] = await db
    .select({
      projectId: pipelineRuns.projectId,
      version: pipelineRuns.releaseVersion,
      cutAt: pipelineRuns.createdAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run?.version) return outcome;
  const meta = (run.metadata ?? {}) as { issueIds?: unknown; finish?: { commit?: unknown } };
  const roster = Array.isArray(meta.issueIds)
    ? meta.issueIds.filter((id): id is string => typeof id === 'string')
    : [];
  const release: ShippingRelease = {
    runId,
    version: run.version,
    cutAt: run.cutAt,
    commit: typeof meta.finish?.commit === 'string' ? meta.finish.commit : null,
  };
  const late = await heldBy(
    run.projectId,
    await waitingIssueIds(run.projectId),
    [{ ...release, issueIds: roster }],
    { markedAfterCut: true },
  );
  for (const [issueId, owed] of late) {
    try {
      const row = await readShippedInRow(run.projectId, issueId);
      if (!row?.landedAt) continue;
      refuseCutBeforeLanding(row.issSeq, row.landedAt, release);
      await shipInto({
        projectId: run.projectId,
        row,
        release,
        actor,
        authorId: authorOf(actor),
        notice:
          `Shipped in ${release.version}, recorded by that release's finish: this issue landed at ` +
          `${row.landedAt.toISOString()}, before ${release.version} was cut at ` +
          `${release.cutAt.toISOString()}, and was marked merged only after the cut, so the cut's ` +
          `roster never named it. It is closed into ${release.version}.`,
      });
      outcome.claimed.push(issueId);
    } catch (err) {
      if (isRefusal(err, FENCE_LOST)) throw err;
      const reason = reasonOf(err);
      outcome.leftOut.push({
        issueId,
        code: refusalCodeOf(err) ?? 'RELEASE_SHIPPED_IN_UNCLAIMED',
        reason,
        owes: 'agent',
      });
      await writeReleaseHolds({
        projectId: run.projectId,
        issueIds: [issueId],
        holdFor: () => shippedInHold({ releases: [release], commit: owed.commit, refused: reason }),
        now: new Date(),
      });
    }
  }
  if (late.size > 0) {
    await writeRunMetadata(runId, { merge: { lateMarks: outcome }, touch: false });
    logger.info(
      { runId, claimed: outcome.claimed.length, leftOut: outcome.leftOut.length },
      'release-batch: the finish recorded the late-marked landings it holds',
    );
  }
  return outcome;
}

/** What an abort did with a roster whose landing a shipped release may already hold. */
export interface AbortShippedOutcome {
  /** Recorded as shipped in the release the abort named, and closed into it. */
  recorded: string[];
  /** Held for their agent, naming the shipped-in record to make. */
  heldForAgent: string[];
}

/**
 * ISS-888: an aborted release's roster, back at the gate. Where the abort names the earlier release
 * that already shipped it (`shippedIn`, the release run's record read with git), each issue is
 * recorded there through the same door its agent would use. Every issue whose landing a shipped release
 * cut after it holds by Forge's rows, and every one that record could not close, is held for its
 * agent naming the shipped-in act, whatever blocker the abort named: whether it shipped is the
 * agent's to read, never a person's.
 */
export async function settleAbortedShipped(args: {
  projectId: string;
  runId: string;
  version: string | null;
  reason: string;
  issueIds: readonly string[];
  shippedIn?: { version: string; evidence: string } | undefined;
  userId: string;
}): Promise<AbortShippedOutcome> {
  const outcome: AbortShippedOutcome = { recorded: [], heldForAgent: [] };
  if (args.issueIds.length === 0) return outcome;
  const refused = new Map<string, string>();
  if (args.shippedIn) {
    for (const issueId of args.issueIds) {
      try {
        await recordShippedIn({
          projectId: args.projectId,
          issueId,
          version: args.shippedIn.version,
          evidence: args.shippedIn.evidence,
          userId: args.userId,
        });
        outcome.recorded.push(issueId);
      } catch (err) {
        refused.set(issueId, reasonOf(err));
      }
    }
  }
  const rest = args.issueIds.filter((id) => !outcome.recorded.includes(id));
  const shipped = (await shippedReleaseRuns(args.projectId)).filter((r) => r.runId !== args.runId);
  const earlier = await heldBy(args.projectId, rest, shipped, { markedAfterCut: false });
  // what a refused record names: the release the abort said shipped it, as Forge holds it if it does
  const said = args.shippedIn
    ? [
        {
          version: args.shippedIn.version,
          commit: shipped.find((r) => r.version === args.shippedIn?.version)?.commit ?? null,
        },
      ]
    : [];
  const commits = refused.size > 0 ? await markedCommitsOf([...refused.keys()]) : new Map();
  const held = rest.filter((id) => earlier.has(id) || refused.has(id));
  await writeReleaseHolds({
    projectId: args.projectId,
    issueIds: held,
    holdFor: (id) => {
      const found = earlier.get(id);
      return abortShippedInHold({
        version: args.version,
        reason: args.reason,
        releases: found?.releases ?? said,
        commit: found?.commit ?? commits.get(id) ?? null,
        refused: refused.get(id),
      });
    },
    now: new Date(),
  });
  outcome.heldForAgent = held;
  return outcome;
}
