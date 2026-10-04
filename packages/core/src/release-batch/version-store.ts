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
import { readProjectDocument } from '../project-config/service.js';
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

/** The four ways a re-cut can be wrong, each refused by its own reason. */
const recutRefused = (recutOf: string, reason: string) =>
  refuseRelease('RELEASE_RECUT_REFUSED', `${recutOf} cannot be re-cut: ${reason}`, '/recutOf');

/** Allocation is serialized per project, so a second writer of the column is refused, not retried. */
const versionConflict = (projectId: string, version: string) =>
  refuseRelease(
    'RELEASE_VERSION_CONFLICT',
    `${version} could not be cut for project ${projectId}: the row already carried a version, or ` +
      'another release on this project already wears that number. Allocation is serialized per ' +
      'project, so this means a writer other than `cutReleaseVersion` set ' +
      '`pipeline_runs.release_version`. Nothing was cut.',
  );

/** Statuses a release run is still open at, which `queries.ts` reads the same way. */
const OPEN_RUN_STATUSES = ['running', 'paused'] as const;

/** Serialize allocation per project for the transaction, so two cuts queue rather than race. */
async function lockProjectVersions(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'releaseVersion', projectId);
}

export interface ReleaseRowReading {
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

/**
 * Each of the four ways a caller can be wrong is refused by its own reason: a re-cut silently
 * turned into a fresh minor is the burn rule failing in the one direction nobody would notice.
 */
export function ruleOnRecut(recutOf: string, highest: ReleaseRowReading | null): ReleaseVersion {
  const asked = parseReleaseVersion(recutOf);
  if (!asked) {
    throw recutRefused(recutOf, `it is not a version. Send ${RELEASE_VERSION_SHAPE}`);
  }
  if (asked.pre) {
    throw recutRefused(
      recutOf,
      'a prerelease is never re-cut: the next cut on its line takes the next number, the failed ' +
        'one stays burned. Omit `recutOf`',
    );
  }
  if (!highest) {
    throw recutRefused(
      recutOf,
      'this project has cut no release at all, so there is nothing to re-cut. Omit `recutOf` and ' +
        'the first release cuts 0.1.0',
    );
  }
  const highestText = formatReleaseVersion(highest.version);
  if (highestText !== formatReleaseVersion(asked)) {
    throw recutRefused(
      recutOf,
      `this project's highest release is ${highestText}, and the patch digit is reserved for ` +
        'a re-cut of the LAST release. Re-cutting anything older would put a lower version after a ' +
        `higher one. Send \`recutOf\` as ${highestText}, or omit it to cut a new release`,
    );
  }
  if ((OPEN_RUN_STATUSES as readonly string[]).includes(highest.status)) {
    throw recutRefused(
      recutOf,
      `release run ${highest.runId} is still ${highest.status}, so that release has not failed ` +
        'yet. Abort it first, then re-cut',
    );
  }
  if (highest.shipped) {
    throw recutRefused(
      recutOf,
      `release run ${highest.runId} SHIPPED, and the patch digit is reserved for a re-cut after a ` +
        'FAILED release. Omit `recutOf` to cut a new release',
    );
  }
  return highest.version;
}

export function ruleAboveHighest(
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

export interface CutReleaseVersionArgs {
  runId: string;
  projectId: string;
  /** The failed release being cut again, which raises the patch digit instead of the minor. */
  recutOf?: string | undefined;
}

/**
 * The only writer of `pipeline_runs.release_version`. Called on the executor that inserted the
 * release row, so no committed release row ever exists without a version.
 */
export async function cutReleaseVersion(tx: Tx, args: CutReleaseVersionArgs): Promise<string> {
  const { runId, projectId, recutOf } = args;
  await lockProjectVersions(tx, projectId);

  const highest = await highestCutVersion(tx, projectId);
  const line = await releaseLineOf(projectId);
  if (line && recutOf !== undefined) {
    throw recutRefused(
      recutOf,
      `this project numbers every release as a prerelease of ${formatReleaseVersion(line.of)} ` +
        '(project document `release.prerelease`), so a failed one is followed by the next number ' +
        'on that line. Omit `recutOf`',
    );
  }
  // `!== undefined`, not truthiness: `recutOf: ''` asked for a re-cut with a value that is not a
  // version, and truthiness would absorb it as "no re-cut asked for" and cut a fresh minor.
  const recutFrom = recutOf !== undefined ? ruleOnRecut(recutOf, highest) : null;
  const next = nextReleaseVersion(highest?.version ?? null, recutFrom, line);
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

  const written = await tx.execute<{ id: string }>(sql`
    UPDATE pipeline_runs
    SET release_version = ${version}, updated_at = now()
    WHERE id = ${runId}
      AND release_version IS NULL
    RETURNING id
  `);
  if (written.length !== 1) throw versionConflict(projectId, version);
  return version;
}

/**
 * Called by `finishReleaseBatch` once the probes agree the release is live, and by nothing else.
 * Idempotent by the `IS NULL` guard: the moment a release shipped is not a thing a retry may move.
 */
export async function markReleaseShipped(runId: string, executor: Tx = db): Promise<void> {
  await executor.execute(sql`
    UPDATE pipeline_runs
    SET release_released_at = now(), updated_at = now()
    WHERE id = ${runId}
      AND release_version IS NOT NULL
      AND release_released_at IS NULL
  `);
}
