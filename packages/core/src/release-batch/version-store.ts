// Where a release's version lives, and the only writer of it.
//
// TWO READERS, not interchangeable. `highestCutVersion` spans every release row that ever cut a
// number, whatever became of it: a failed 0.5.0 stays the highest, so nothing wears it again, and
// narrowing it to completed releases brings burned numbers back. `currentReleaseVersion` answers
// what is SERVING and reads the ship stamp, because `cancelConcludedRun` flips a `completed` run
// to `cancelled` while its bytes are still live. The partial unique index is only the backstop.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import { stampReleaseVersion } from '../pipeline/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { refuseRelease } from './refuse.js';
import {
  compareReleaseVersions,
  formatReleaseVersion,
  isStorableReleaseVersion,
  nextReleaseVersion,
  type PrereleaseLine,
  parseReleaseVersion,
  RELEASE_VERSION_SHAPE,
  type ReleaseVersion,
} from './version.js';

/** Allocation is serialized per project, so a second writer of the column is refused, not retried. */
const versionConflict = (projectId: string, version: string) =>
  refuseRelease(
    'RELEASE_VERSION_CONFLICT',
    `${version} could not be cut for project ${projectId}: the row already carried a version, or ` +
      'another release on this project already wears that number. Allocation is serialized per ' +
      'project, so this means a writer other than `cutReleaseVersion` set ' +
      '`pipeline_runs.release_version`. Nothing was cut.',
  );
/** Serialize allocation per project for the transaction, so two cuts queue rather than race. */
async function lockProjectVersions(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'releaseVersion', projectId);
}

interface ReleaseRowReading {
  runId: string;
  version: ReleaseVersion;
  status: string;
  shipped: boolean;
}

// cm:why ordered here by `compareReleaseVersions` rather than in SQL: `'0.10.0' < '0.9.0'` as text,
// and a prerelease's `-dev.N` tail has no integer-array cast; the shape CHECK on the column is what
// makes every stored value parse.
export async function highestCutVersion(
  executor: Tx,
  projectId: string,
): Promise<ReleaseRowReading | null> {
  const rows = await executor.execute<{
    id: string;
    release_version: string;
    status: string;
    release_released_at: Date | null;
  }>(sql`
    SELECT r.id, r.release_version, r.status, r.release_released_at
    FROM pipeline_runs r
    WHERE r.project_id = ${projectId}
      AND r.release_version IS NOT NULL
  `);
  let highest: ReleaseRowReading | null = null;
  for (const row of rows) {
    const version = parseReleaseVersion(row.release_version);
    if (!version) {
      throw versionConflict(
        projectId,
        `${row.release_version} (stored on run ${row.id}, which is not ${RELEASE_VERSION_SHAPE})`,
      );
    }
    if (highest && compareReleaseVersions(version, highest.version) <= 0) continue;
    highest = {
      runId: row.id,
      version,
      status: row.status,
      shipped: row.release_released_at !== null,
    };
  }
  return highest;
}

export async function releaseLineOf(projectId: string): Promise<PrereleaseLine | null> {
  const declared = (await readProjectDocument(projectId))?.document.release?.prerelease;
  const of = declared ? parseReleaseVersion(declared.of) : null;
  return declared && of ? { of, label: declared.label } : null;
}

/** The version the last release to SHIP cut. `null` when no release here has ever shipped. */
export async function currentReleaseVersion(projectId: string): Promise<string | null> {
  const rows = await db.execute<{ release_version: string }>(sql`
    SELECT r.release_version
    FROM pipeline_runs r
    WHERE r.project_id = ${projectId}
      AND r.release_version IS NOT NULL
      AND r.release_released_at IS NOT NULL
    ORDER BY r.release_released_at DESC
    LIMIT 1
  `);
  return rows[0]?.release_version ?? null;
}

function ruleAboveHighest(
  projectId: string,
  next: ReleaseVersion,
  highest: ReleaseRowReading | null,
): void {
  if (!highest || compareReleaseVersions(next, highest.version) > 0) return;
  // A prerelease line declared below what this project already cut would hand out a lower version
  // after a higher one; the line is the operator's to raise, never skipped forward here.
  throw refuseRelease(
    'RELEASE_VERSION_LINE_BEHIND',
    `the next version for project ${projectId} would be ${formatReleaseVersion(next)}, and this ` +
      `project already cut ${formatReleaseVersion(highest.version)}. Nothing was cut. Raise ` +
      '`release.prerelease.of` in the project document to the release the line now previews.',
  );
}

interface CutReleaseVersionArgs {
  runId: string;
  projectId: string;
}

/**
 * The only writer of `pipeline_runs.release_version`. Called on the executor that inserted the
 * release row, so no committed release row ever exists without a version.
 */
export async function cutReleaseVersion(tx: Tx, args: CutReleaseVersionArgs): Promise<string> {
  const { runId, projectId } = args;
  await lockProjectVersions(tx, projectId);

  const highest = await highestCutVersion(tx, projectId);
  const line = await releaseLineOf(projectId);
  const next = nextReleaseVersion(highest?.version ?? null, line);
  // Refused here rather than at the column, which would name itself instead of the rule.
  if (!isStorableReleaseVersion(next)) {
    throw refuseRelease(
      'RELEASE_VERSION_EXHAUSTED',
      `the next version for project ${projectId} would be ${formatReleaseVersion(next)}, and a ` +
        'release version holds at most nine digits per component. Nothing was cut. Raise the ' +
        'major digit by hand on the next release row to start a fresh sequence.',
    );
  }
  ruleAboveHighest(projectId, next, highest);
  const version = formatReleaseVersion(next);

  if (!(await stampReleaseVersion(runId, version, tx))) throw versionConflict(projectId, version);
  return version;
}
