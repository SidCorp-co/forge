// Where a release's version lives, and the only writer of it.
//
// ISS-1120, the owner's third answer: the number lives in a COLUMN on the release row. A release is
// the `pipeline_runs` row carrying `metadata.source = 'release-batch'`, so the column is
// `pipeline_runs.release_version` and the release row is the row that wears it.
//
// TWO READERS, and they are not interchangeable:
//
//   `highestCutVersion` spans every release row that ever cut a number, whatever became of the
//   release. That is the whole of the burn — a failed 0.5.0 is still the highest, so the next new
//   release is 0.6.0 and nothing can ever wear 0.5.0 again. Narrow this read to completed releases
//   and burned numbers come back, which `version.test.ts` and `release-version-e2e.test.ts` both
//   watch for.
//
//   `currentReleaseVersion` answers what the project is SERVING, and reads the ship stamp rather
//   than the run's status. `cancelConcludedRun` deliberately flips a `completed` run to
//   `cancelled`, so a release that shipped and was aborted afterwards has a status that says it
//   never happened while its bytes are still live. The stamp is written once and nothing clears it.
//
// The cut takes a per-project advisory lock for the length of the transaction, so two releases
// cutting at the same moment queue rather than race. The partial unique index behind it is the
// backstop, not the mechanism: reaching it means a writer other than this file set the column, and
// that is refused by name rather than retried.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { ReleaseRecutRefusedError, ReleaseVersionConflictError } from './errors.js';
import {
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  RELEASE_VERSION_SHAPE,
  type ReleaseVersion,
} from './version.js';

/** Statuses a release run is still open at, which `queries.ts` reads the same way. */
const OPEN_RUN_STATUSES = ['running', 'paused'] as const;

/**
 * Serialize version allocation for one project for the rest of this transaction. Two integers
 * because `pg_advisory_xact_lock` takes a pair: a namespace nothing else in this schema uses, and
 * the project's own hash.
 */
const VERSION_LOCK_NAMESPACE = 1120;

async function lockProjectVersions(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${VERSION_LOCK_NAMESPACE}, hashtext(${projectId}))`,
  );
}

/** One release row, as the cut has to see it to rule on a re-cut. */
export interface ReleaseRowReading {
  runId: string;
  version: ReleaseVersion;
  status: string;
  shipped: boolean;
}

/**
 * The highest version ever cut on this project and the row wearing it, or `null` when the project
 * has never cut one. Ordered by the digits — `string_to_array(...)::int[]` compares element by
 * element — because `'0.10.0' < '0.9.0'` as text and is not as a version. The shape CHECK on the
 * column is what makes that cast safe.
 */
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
    ORDER BY string_to_array(r.release_version, '.')::int[] DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const version = parseReleaseVersion(row.release_version);
  if (!version) {
    // The CHECK constraint makes this unreachable through the database. It is not silently
    // repaired: a value the shape refuses means the constraint is gone, and guessing past it is
    // how the next cut collides with a number nobody can read.
    throw new ReleaseVersionConflictError(
      projectId,
      `${row.release_version} (stored on run ${row.id}, which is not ${RELEASE_VERSION_SHAPE})`,
    );
  }
  return {
    runId: row.id,
    version,
    status: row.status,
    shipped: row.release_released_at !== null,
  };
}

/**
 * The version the project is serving: the one the last release to SHIP cut. `null` when no release
 * on this project has ever shipped.
 */
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
 * Rule on a `recutOf` against the project's highest release, and answer with the version it may be
 * re-cut from. Each of the four ways a caller can be wrong is refused by its own reason, because a
 * re-cut silently turned into a fresh minor is the burn rule failing in the one direction nobody
 * would notice.
 *
 * Takes plain data and touches no database, so `version-store.test.ts` plants each refusal with the
 * one value it exists to refuse rather than reaching one through a Postgres.
 */
export function ruleOnRecut(recutOf: string, highest: ReleaseRowReading | null): ReleaseVersion {
  const asked = parseReleaseVersion(recutOf);
  if (!asked) {
    throw new ReleaseRecutRefusedError(recutOf, `it is not a version. Send ${RELEASE_VERSION_SHAPE}`);
  }
  if (!highest) {
    throw new ReleaseRecutRefusedError(
      recutOf,
      'this project has cut no release at all, so there is nothing to re-cut. Omit `recutOf` and ' +
        'the first release cuts 0.1.0',
    );
  }
  const highestText = formatReleaseVersion(highest.version);
  if (highestText !== formatReleaseVersion(asked)) {
    throw new ReleaseRecutRefusedError(
      recutOf,
      `this project's highest release is ${highestText}, and the patch digit is reserved for ` +
        'a re-cut of the LAST release. Re-cutting anything older would put a lower version after a ' +
        `higher one. Send \`recutOf\` as ${highestText}, or omit it to cut a new release`,
    );
  }
  if ((OPEN_RUN_STATUSES as readonly string[]).includes(highest.status)) {
    throw new ReleaseRecutRefusedError(
      recutOf,
      `release run ${highest.runId} is still ${highest.status}, so that release has not failed ` +
        'yet. Abort it first, then re-cut',
    );
  }
  if (highest.shipped) {
    throw new ReleaseRecutRefusedError(
      recutOf,
      `release run ${highest.runId} SHIPPED, and the patch digit is reserved for a re-cut after a ` +
        'FAILED release. Omit `recutOf` to cut a new release',
    );
  }
  return highest.version;
}

export interface CutReleaseVersionArgs {
  runId: string;
  projectId: string;
  /** The failed release being cut again, which raises the patch digit instead of the minor. */
  recutOf?: string | undefined;
}

/**
 * Cut this release's version onto its row. The only writer of `pipeline_runs.release_version`.
 *
 * Called on the executor that inserted the release row, inside the same transaction, so there is
 * never a committed release row without a version and no subscriber ever sees one.
 */
export async function cutReleaseVersion(tx: Tx, args: CutReleaseVersionArgs): Promise<string> {
  const { runId, projectId, recutOf } = args;
  await lockProjectVersions(tx, projectId);

  const highest = await highestCutVersion(tx, projectId);
  const recutFrom = recutOf ? ruleOnRecut(recutOf, highest) : null;
  const version = formatReleaseVersion(nextReleaseVersion(highest?.version ?? null, recutFrom));

  const written = await tx.execute<{ id: string }>(sql`
    UPDATE pipeline_runs
    SET release_version = ${version}, updated_at = now()
    WHERE id = ${runId}
      AND release_version IS NULL
    RETURNING id
  `);
  if (written.length !== 1) throw new ReleaseVersionConflictError(projectId, version);
  return version;
}

/**
 * Stamp the ship onto the release row. Called by `finishReleaseBatch` once the probes have agreed
 * the release is live, and by nothing else.
 *
 * Idempotent by the `IS NULL` guard: a finish replayed against an already-stamped release leaves
 * the first stamp standing, because the moment a release shipped is not a thing a retry may move.
 */
export async function markReleaseShipped(runId: string): Promise<void> {
  await db.execute(sql`
    UPDATE pipeline_runs
    SET release_released_at = now(), updated_at = now()
    WHERE id = ${runId}
      AND release_version IS NOT NULL
      AND release_released_at IS NULL
  `);
}

/** The version on one release row, or `null` when the row is not a release or carries none. */
export async function readReleaseVersion(runId: string): Promise<string | null> {
  const rows = await db.execute<{ release_version: string | null }>(sql`
    SELECT release_version FROM pipeline_runs WHERE id = ${runId} LIMIT 1
  `);
  return rows[0]?.release_version ?? null;
}
