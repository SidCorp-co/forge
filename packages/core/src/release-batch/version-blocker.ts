// The version a re-cut would take, as a release blocker where the rule cannot decide it (ADR 0011).
// Split from `blockers.ts`, which reports it in its place in every door's order.

import { db } from '../db/client.js';
import { blocker, evaluate } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import { decideVersion, lineageOf } from './version-rule.js';
import { readLineageRuns, releaseLineOf, undecidedDetails } from './version-store.js';

/**
 * A re-cut whose version the rule cannot decide (ADR 0011): an earlier attempt on this same roster
 * ended without saying what outside Forge carries its version.
 */
export async function versionBlocker(
  projectId: string,
  roster: string[] | undefined,
  out: ReleaseBlocker[],
): Promise<void> {
  if (!roster || roster.length === 0) return;
  const ids = roster.map((id) => id.toLowerCase());
  const read = await evaluate(
    'version',
    async () => {
      const runs = await readLineageRuns(db, projectId);
      return { runs, decision: decideVersion(runs, ids, await releaseLineOf(projectId)) };
    },
    out,
  );
  if (read?.decision.kind !== 'undecided') return;
  const d = read.decision;
  const { headOf, attemptsOf } = lineageOf(read.runs);
  const chain = attemptsOf.get(headOf.get(d.recutOf.id)?.id ?? d.recutOf.id) ?? [d.recutOf];
  out.push(blocker('RELEASE_VERSION_UNDECIDED', undecidedDetails(projectId, d, chain)));
}
