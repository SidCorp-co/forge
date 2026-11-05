// What a project's release record says is live, where its production names no commit it serves
// (ISS-900, FB-479). An owner who rules out commit fields (agenfold's `release-is-the-agents-record`:
// a release is an explicit version in the record, the tag and what the app reports, and Forge never
// checks or matches a commit) declares no source probe, so no commit is ever read for production and a
// verdict naming one could never count. There the release version is the identity: a verdict judged
// on version V counts while V, or a later release the record carries, is what the record says is
// live. Read from Forge's own rows alone: no probe, host or box is asked, and no commit is compared.

import { db } from '../db/client.js';
import { reopenedRoundsOf, reworkedSince } from '../issues/index.js';
import {
  type NamedEnvironment,
  productionOf,
  readProjectDocument,
} from '../project-config/index.js';
import { releaseProbesOf } from './channel.js';
import { compareReleaseVersions, parseReleaseVersion } from './version.js';
import { givenReleaseVersion, readStampedReleases, servingRelease } from './version-store.js';
import { issueIdsOf } from './versions.js';

/** One shipped release as the line reads it (`requirements/standing-identity.ts:ReleasedLine`). */
interface ShippedOnLine {
  at: Date;
  /** Whether the live release carries it: shipped no later, at no higher a version. */
  carried: boolean;
  /** Every other shipped version it carries itself, by the same rule. */
  carries: readonly string[];
  /** The issues its own record names (`versions.ts:issueIdsOf`), which it holds (ISS-957). */
  issueIds: readonly string[];
  /** Of those, the ones reopened since it claimed them and re-landed since, or with no landing now
   *  (`issues/release-evidence.ts:reworkedSince`): it holds the round it carried, never the fix
   *  re-landed after (ISS-967), and still holds one whose landing the reopen left unchanged (ISS-971). */
  reworked: readonly string[];
}

/** What the requirement coverage reads of the line (`requirements/standing-identity.ts:ReleasedLine`). */
export interface ReleasedLineRead {
  why: string;
  live: { version: string; at: Date } | null;
  shipped: Map<string, ShippedOnLine>;
}

/**
 * The project's shipped releases, oldest first, and the one production serves as the one its record
 * says is live (`version-store.ts:servingRelease`: the highest version, never the record written
 * last), where its production declares no source probe; null on a project with no production
 * environment (its landing is the delivery, `landed-build-holds.ts`) and on one whose production reads
 * the commit it serves, where coverage keeps weighing by commit (`judged-build.ts:liveBuildHolds`).
 *
 * A release ships once its run is stamped (`pipeline_runs.release_released_at`): an agent's record
 * that closed what it carried, or a batch that finished. One shipped counts as carried by another only
 * where it was stamped no later at no higher a version: a release recorded after the live one at a
 * lower version (a backfill, or a hotfix on an older line) never displaces it, and nothing says the
 * live one carries it, so it is not read as carried.
 */
/**
 * Why `production` names no commit it serves, the reason its releases are its agent's record by
 * version; null where a probe reads the commit it serves. The one reading `releasedLineOf` and the
 * release's criteria basis (`criteria-basis.ts:criteriaBasisOf`, ISS-957) share.
 */
export function servedCommitUnnamed(production: NamedEnvironment): string | null {
  const { verify, verifySource } = releaseProbesOf(production);
  if (verify) return null;
  return verifySource === 'declared-unusable'
    ? `its production \`${production.name}\` declares runtime probes that each identify an artifact, never the source, so no commit is read for what it serves: its releases are its agent's record by version`
    : `its production \`${production.name}\` declares no source probe, so no commit is read for what it serves: its releases are its agent's record by version`;
}

export async function releasedLineOf(projectId: string): Promise<ReleasedLineRead | null> {
  const held = await readProjectDocument(projectId);
  const production = held ? productionOf(held.document) : null;
  if (!production) return null;
  const why = servedCommitUnnamed(production);
  if (why === null) return null;
  const shipped = (await readStampedReleases(projectId)).map((r) => ({
    ...r,
    parsed: parseReleaseVersion(r.version),
  }));
  type Shipped = (typeof shipped)[number];
  const live = servingRelease(shipped, production.declaration.deploysFrom ?? null);
  if (!live) return { why, live: null, shipped: new Map() };
  // one rule for what any release carries, the live one included: stamped no later, no higher
  const carries = (v: Shipped, holder: Shipped) =>
    v === holder ||
    (v.at.getTime() <= holder.at.getTime() &&
      v.parsed !== null &&
      holder.parsed !== null &&
      compareReleaseVersions(v.parsed, holder.parsed) <= 0);
  const carriedBy = (holder: Shipped) =>
    shipped.filter((v) => v !== holder && carries(v, holder)).map((v) => v.version);
  const named = shipped.map((v) => ({ v, issueIds: issueIdsOf(v.metadata) }));
  const reworkedIn = await reworkedOf(named);
  return {
    why,
    live: { version: live.version, at: live.at },
    shipped: new Map(
      named.map(({ v, issueIds }) => [
        v.version,
        {
          at: v.at,
          carried: carries(v, live),
          carries: carriedBy(v),
          issueIds,
          reworked: reworkedIn(v, issueIds),
        },
      ]),
    ),
  };
}

/**
 * Per shipped release, the issues its record names whose round it carried is no longer their current
 * one, by the one rule the release read names them reworked by (`issues/release-evidence.ts:reworkedSince`):
 * reopened since it claimed them, and re-landed since, or with no landing standing now. It carried
 * their earlier round, so it holds none of the fix re-landed after (ISS-967, FB-495: agenfold's
 * ISS-160 failed live on 0.128.0, was reopened and re-landed, and its observable criterion was owed on
 * 0.128.0 for ever). One reopened with its landing unchanged is still held by the release that shipped
 * that landing (ISS-971, FB-497: agenfold's ISS-5). Read from the issues' move history and merge marks
 * alone, three statements for the whole line.
 */
async function reworkedOf(
  named: ReadonlyArray<{ issueIds: readonly string[] }>,
): Promise<(v: { openedAt: Date; at: Date }, issueIds: readonly string[]) => string[]> {
  const ids = [...new Set(named.flatMap((n) => n.issueIds.map((id) => id.toLowerCase())))];
  const rounds = await reopenedRoundsOf(db, ids);
  return (v, issueIds) =>
    issueIds.filter((id) => {
      const i = rounds.get(id.toLowerCase());
      return i !== undefined && reworkedSince({ openedAt: v.openedAt, releasedAt: v.at }, i);
    });
}

/** What a requirement reads of its project's release line, handed in at boot (`requirements/dependents.ts`). */
export const releasedLineReads = {
  releasedLine: releasedLineOf,
  releaseVersionOf: givenReleaseVersion,
};
