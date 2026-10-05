// A release whose production declares no source probe is proved by what production's deployment
// record says it serves (`serving-reading.ts:readServingNow`), or not at all: a close nothing
// checked against the commit is refused `RELEASE_NOT_VERIFIED` rather than recorded as unverified.

import { readServingNow, servingClause, whyUncorroborated } from './serving-reading.js';
import { claimedCommit, deploymentConfirms, notAWholeCommit } from './verify.js';

export type DeploymentOutcome =
  | { ok: true; identity: string; readings: string[] }
  | { ok: false; reason: string; live: string | null };

const NO_COMMIT =
  'this production declares no runtime probe identifying the source, so the release is proved by the commit its deployment record names, and a finish naming no commit has nothing to compare it with. Call finish again with `commit`, the whole sha you pushed.';

/** Whether production's deployment record says it serves `expected`, read once, now. */
export async function verifyByDeploymentRecord(
  projectId: string,
  expected: string | null,
): Promise<DeploymentOutcome> {
  if (expected === null) return { ok: false, reason: NO_COMMIT, live: null };
  const claimed = claimedCommit(expected);
  if (claimed === null) return { ok: false, reason: notAWholeCommit(expected, null), live: null };
  const serving = await readServingNow(projectId);
  if (serving.kind !== 'serving') {
    return {
      ok: false,
      reason: `nothing can show this release is serving ${claimed}: ${whyUncorroborated(serving)} Declare a runtime probe with \`"identifies": "source"\` on the production environment, or deploy through a binding whose platform records the commit it built.`,
      live: null,
    };
  }
  const wrong = serving.served.filter((s) => !deploymentConfirms(claimed, s.commit));
  if (wrong.length > 0) {
    return {
      ok: false,
      reason: `production serves ${servingClause(serving)}, not ${claimed}`,
      live: wrong[0]?.commit ?? null,
    };
  }
  const identity = serving.served[0]?.commit ?? claimed;
  return {
    ok: true,
    identity,
    readings: serving.served.map((s) => `${s.commit} at ${s.where}`),
  };
}
