// What a release repaired to shipped does with its roster (ISS-900, catalog-api 0.4.0 / ISS-34,
// 2026-11-02). A failed release let its claims go, so its roster waits unclaimed at the gate, and a
// close is refused CLOSE_ONLY_BY_RELEASE: no release has claimed it. The repair says the release
// shipped, so it settles its roster as that release's finish would have: each roster issue still
// waiting, whose landing the release holds by the rule a shipped-in record is held to
// (`refuseCutBeforeLanding`), is claimed for it and closed through the one closer a finish uses
// (`shipped-in.ts:shipInto`, `close-roster.ts`). One it cannot close is held for its agent, naming the
// record to make, and listed by name in the repair's answer, as a finish holds what it could not close.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { accountActor } from '../issues/index.js';
import { isRefusal, refusalCodeOf } from '../lib/refusal.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { RELEASE_SHIPPED_IN_OWED, type ReleaseHold, writeReleaseHolds } from './hold.js';
import { FENCE_LOST, reasonOf } from './refuse.js';
import {
  RECORD_IT,
  readShippedInRow,
  refuseCutBeforeLanding,
  type ShippingRelease,
  shipInto,
} from './shipped-in.js';

/** The repaired run as a shipped-in record names a release: its version, its cut and the commit it
 *  named (a batch's finish, or a record's), where it named one. */
async function repairedRelease(runId: string): Promise<ShippingRelease | null> {
  const [run] = await db
    .select({
      version: pipelineRuns.releaseVersion,
      cutAt: pipelineRuns.createdAt,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!run?.version) return null;
  const meta = (run.metadata ?? {}) as { commit?: unknown; finish?: { commit?: unknown } };
  const named = meta.finish?.commit ?? meta.commit;
  return {
    runId,
    version: run.version,
    cutAt: run.cutAt,
    commit: typeof named === 'string' ? named : null,
  };
}

/** What a repair did with its release's roster. */
export interface RepairedRoster {
  /** Closed into the repaired release. */
  closed: string[];
  /** Left at the gate, each held for its agent naming the record to make, and why. */
  heldForAgent: Array<{ issueId: string; code: string; reason: string }>;
}

/** The hold a roster issue the repair could not close waits under: its agent's record, never a person's. */
export function repairedRosterHold(version: string, refused: string): ReleaseHold {
  return {
    code: RELEASE_SHIPPED_IN_OWED,
    reason:
      `Release ${version} ended failed and was repaired to shipped, and its roster carried this ` +
      `issue, but the repair could not close it into ${version}: ${refused}. Once what refused it is ` +
      `cleared, ${RECORD_IT}`,
    owes: 'agent',
    waitingFor: `the issue's agent to record it as shipped in ${version}`,
  };
}

/**
 * Each issue of `roster` still waiting at the gate, closed into the repaired release `runId`, or held
 * for its agent naming why. An issue the roster carried that has moved on (closed, reopened, claimed
 * by a release at work) is left where it stands.
 */
export async function settleRepairedRoster(args: {
  projectId: string;
  runId: string;
  roster: readonly string[];
  userId: string;
  evidence: string;
}): Promise<RepairedRoster> {
  const out: RepairedRoster = { closed: [], heldForAgent: [] };
  if (args.roster.length === 0) return out;
  const release = await repairedRelease(args.runId);
  if (!release) return out;
  const actor = await accountActor(args.userId);
  for (const issueId of args.roster) {
    const row = await readShippedInRow(args.projectId, issueId);
    if (!row || row.status !== RELEASE_GATE_STATUS) continue;
    if (row.claimedBy !== null && !row.endedClaim && row.claimedBy !== args.runId) continue;
    try {
      if (!row.landedAt) {
        throw new Error('it holds no merged mark, so there is no landing the release could hold');
      }
      refuseCutBeforeLanding(row.issSeq, row.landedAt, release);
      await shipInto({
        projectId: args.projectId,
        row,
        release,
        actor,
        authorId: args.userId,
        notice:
          `Shipped in ${release.version}: that release ended failed and was repaired to shipped ` +
          `(${args.evidence}), and its roster carried this issue, so it is closed into ${release.version}.`,
      });
      out.closed.push(issueId);
    } catch (err) {
      if (isRefusal(err, FENCE_LOST)) throw err;
      const reason = reasonOf(err);
      out.heldForAgent.push({
        issueId,
        code: refusalCodeOf(err) ?? RELEASE_SHIPPED_IN_OWED,
        reason,
      });
      await writeReleaseHolds({
        projectId: args.projectId,
        issueIds: [issueId],
        holdFor: () => repairedRosterHold(release.version, reason),
        now: new Date(),
      });
    }
  }
  return out;
}
