// What a project's release record says is live, where its production names no commit it serves
// (ISS-900, FB-479). An owner who rules out commit fields (agenfold's `release-is-the-agents-record`:
// a release is an explicit version in the record, the tag and what the app reports, and Forge never
// checks or matches a commit) declares no source probe, so no commit is ever read for production and a
// verdict naming one could never count. There the release version is the identity: a verdict judged
// on version V counts while V, or a later release the record carries, is what the record says is
// live. Read from Forge's own rows alone: no probe, host or box is asked, and no commit is compared.

import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { productionOf, readProjectDocument } from '../project-config/index.js';
import { releaseProbesOf } from './channel.js';
import { compareReleaseVersions, parseReleaseVersion } from './version.js';
import { givenReleaseVersion } from './version-store.js';

/** One shipped release as the line reads it (`requirements/standing-identity.ts:ReleasedLine`). */
interface ShippedOnLine {
  at: Date;
  /** Whether the live release carries it: shipped no later, at no higher a version. */
  carried: boolean;
}

/** What the requirement coverage reads of the line (`requirements/standing-identity.ts:ReleasedLine`). */
export interface ReleasedLineRead {
  why: string;
  live: { version: string; at: Date } | null;
  shipped: Map<string, ShippedOnLine>;
}

/**
 * The project's shipped releases, oldest first, and the newest as the one its record says is live,
 * where its production declares no source probe; null on a project with no production environment
 * (its landing is the delivery, `landed-build-holds.ts`) and on one whose production reads the commit
 * it serves, where coverage keeps weighing by commit (`judged-build.ts:liveBuildHolds`).
 *
 * A release ships once its run is stamped (`pipeline_runs.release_released_at`): an agent's record
 * that closed what it carried, or a batch that finished. One shipped earlier counts as carried by the
 * live one only where its version is no higher: a line recorded later at a lower version (a hotfix on
 * an older line) says nothing about carrying it, so it is not read as carried.
 */
export async function releasedLineOf(projectId: string): Promise<ReleasedLineRead | null> {
  const held = await readProjectDocument(projectId);
  const production = held ? productionOf(held.document) : null;
  if (!production) return null;
  const { verify, verifySource } = releaseProbesOf(production);
  if (verify) return null;
  const why =
    verifySource === 'declared-unusable'
      ? `its production \`${production.name}\` declares runtime probes that each identify an artifact, never the source, so no commit is read for what it serves: its releases are its agent's record by version`
      : `its production \`${production.name}\` declares no source probe, so no commit is read for what it serves: its releases are its agent's record by version`;
  const rows = await db
    .select({ version: pipelineRuns.releaseVersion, at: pipelineRuns.releaseReleasedAt })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        isNotNull(pipelineRuns.releaseVersion),
        isNotNull(pipelineRuns.releaseReleasedAt),
      ),
    )
    .orderBy(asc(pipelineRuns.releaseReleasedAt), asc(pipelineRuns.id));
  const shipped = rows.flatMap((r) =>
    r.version && r.at
      ? [{ version: r.version, at: r.at, parsed: parseReleaseVersion(r.version) }]
      : [],
  );
  const newest = shipped[shipped.length - 1];
  if (!newest) return { why, live: null, shipped: new Map() };
  const carries = (v: (typeof shipped)[number]) =>
    v === newest ||
    (v.at.getTime() <= newest.at.getTime() &&
      v.parsed !== null &&
      newest.parsed !== null &&
      compareReleaseVersions(v.parsed, newest.parsed) <= 0);
  return {
    why,
    live: { version: newest.version, at: newest.at },
    shipped: new Map(shipped.map((v) => [v.version, { at: v.at, carried: carries(v) }])),
  };
}

/** What a requirement reads of its project's release line, handed in at boot (`requirements/dependents.ts`). */
export const releasedLineReads = {
  releasedLine: releasedLineOf,
  releaseVersionOf: givenReleaseVersion,
};
