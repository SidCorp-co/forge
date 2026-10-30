/**
 * What a served commit holds of a judged one, answered from the releases Forge recorded shipping
 * (`shipped-releases.ts`), never from the host. Releases are cut in sequence on one line, the rule a
 * requirement's coverage already reads (`judged-build.ts:liveBuildHolds`), so a release serving `S`
 * holds every commit a release cut no later than it shipped at, and every landing such a release
 * shipped; the commit of a release cut after it is one `S` does not hold. A landing only a later
 * release shipped may have been on the line all the same, so it is left out, as is every pair no
 * release places:
 * nothing on record answers it, which the caller says rather than reading it as not carried.
 *
 * The weighing's carriage was kept only in the process (`carriage.ts`), so every deploy emptied it,
 * and a read, which asks the host nothing (ISS-774), read each runtime verdict a deploy ago as
 * superseded until a release pass asked again (forge-dev REQ-79, 2026-10-30: 4/9 to 2/9 with no new
 * verdict). The release record is what survives the deploy.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { type Carriage, carriageKey } from '../issues/index.js';
import { type ShippedReleaseRun, shippedReleaseRuns } from './shipped-releases.js';

const WHOLE = /^[0-9a-f]{40}$/i;
const MIN_ABBREVIATION = 7;

/** The release a commit names: whole, or an abbreviation of exactly one release's commit. */
function releaseAt(
  sha: string,
  releases: readonly ShippedReleaseRun[],
): ShippedReleaseRun | undefined {
  const s = sha.trim().toLowerCase();
  if (WHOLE.test(s)) return releases.find((r) => r.commit === s);
  if (s.length < MIN_ABBREVIATION) return undefined;
  const named = releases.filter((r) => r.commit.startsWith(s));
  return named.length === 1 ? named[0] : undefined;
}

/** Per landing commit, the earliest release that shipped an issue landed at it. */
async function releasesShippingLandings(
  projectId: string,
  judged: readonly string[],
  releases: readonly ShippedReleaseRun[],
): Promise<Map<string, ShippedReleaseRun>> {
  const whole = [
    ...new Set(judged.map((j) => j.trim().toLowerCase()).filter((j) => WHOLE.test(j))),
  ];
  const out = new Map<string, ShippedReleaseRun>();
  if (whole.length === 0 || releases.length === 0) return out;
  const landed = await db
    .select({ id: issues.id, sha: issues.mergedCommitSha })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.mergedCommitSha, whole)));
  for (const { id, sha } of landed) {
    const first = releases.find((r) => r.issueIds.includes(id));
    if (!sha || !first) continue;
    const key = sha.toLowerCase();
    const held = out.get(key);
    if (!held || first.cutAt < held.cutAt) out.set(key, first);
  }
  return out;
}

/** Each pair (`judged` × `served`) the project's shipped releases answer, by `carriageKey`. */
export async function recordedCarriage(
  projectId: string,
  judged: readonly string[],
  served: readonly string[],
): Promise<Map<string, Carriage>> {
  const out = new Map<string, Carriage>();
  if (judged.length === 0 || served.length === 0) return out;
  const releases = await shippedReleaseRuns(projectId);
  if (releases.length === 0) return out;
  const landings = await releasesShippingLandings(projectId, judged, releases);
  for (const s of served) {
    const serving = releaseAt(s, releases);
    if (!serving) continue;
    for (const j of judged) {
      const own = releaseAt(j, releases);
      const holder = own ?? landings.get(j.trim().toLowerCase());
      if (!holder || holder.commit === serving.commit) continue;
      const what = own
        ? `release ${holder.version} was cut at it`
        : `release ${holder.version} shipped the issue landed at it`;
      if (holder.cutAt <= serving.cutAt) {
        const by = `${what}, and release ${serving.version}, which serves \`${s}\`, was cut no earlier on the same line`;
        out.set(carriageKey(j, s), { kind: 'descends', by });
      } else if (own) {
        // a landing a later release shipped may still have been on the line before this one was cut
        const why = `${what}, after release ${serving.version}, which serves \`${s}\``;
        out.set(carriageKey(j, s), { kind: 'lacks', why });
      }
    }
  }
  return out;
}
