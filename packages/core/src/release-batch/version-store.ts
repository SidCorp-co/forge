// Where a release's version lives, and the only writer of it (ADR 0011).
//
// A version names a RELEASE, not an attempt. The first cut of a roster claims a version; every
// re-cut of the same roster wears it again until it ships, unless something outside Forge already
// carries it — a pushed tag, a release commit, a published artifact, a notice sent — and then the
// next attempt takes a new version and records why, naming the carrier. Which version is the rule's
// (`version-rule.ts:decideVersion`); this module reads the runs it decides over and writes the
// answer. `currentReleaseVersion` answers what is SERVING: among the runs whose ship stamp is set,
// because `cancelConcludedRun` flips a `completed` run to `cancelled` while its bytes are still live,
// the highest version, never the stamp written last (`servingRelease`). The
// partial unique index `pipeline_runs_release_version_uq` is only the backstop.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { memoizedRead } from '../db/read-memo.js';
import { lockXact } from '../lib/advisory-lock.js';
import { stampReleaseVersion, writeRunMetadata } from '../pipeline/index.js';
import { readProjectDocument, readReleasePath } from '../project-config/index.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { blockerRefusal, refuseRelease } from './refuse.js';
import {
  compareReleaseVersions,
  formatReleaseVersion,
  isStorableReleaseVersion,
  type PrereleaseLine,
  parseReleaseVersion,
  RELEASE_VERSION_SHAPE,
  type ReleaseVersion,
} from './version.js';
import {
  cutRecordOf,
  decideVersion,
  type LineageRun,
  lineageOf,
  type VersionCutRecord,
  type VersionDecision,
} from './version-rule.js';
import { landedOffProduction } from './versions.js';

/** Allocation is serialized per project, so a second writer of the column is refused, not retried. */
const versionConflict = (projectId: string, version: string) =>
  refuseRelease(
    'RELEASE_VERSION_CONFLICT',
    `${version} could not be cut for project ${projectId}: the row already carried a version, or ` +
      'another release on this project still wears that number. Allocation is serialized per ' +
      'project, so this means a writer other than `cutReleaseVersion` set ' +
      '`pipeline_runs.release_version`. Nothing was cut.',
  );

/**
 * Serialize allocation per project for the transaction, so two cuts queue rather than race. Every
 * writer of what the rule reads off an ended attempt — what carries its version — takes it too
 * (`carried.ts`), so a cut never decides on a carrier reading a declaration is about to change.
 */
export async function lockProjectVersions(tx: Tx, projectId: string): Promise<void> {
  await lockXact(tx, 'releaseVersion', projectId);
}

/** The same lock, for a writer that holds a run id: taken before any lock on the run's row. */
export async function lockRunVersions(tx: Tx, runId: string): Promise<void> {
  const rows = await tx.execute<{ project_id: string }>(
    sql`SELECT project_id FROM pipeline_runs WHERE id = ${runId}`,
  );
  const projectId = rows[0]?.project_id;
  if (projectId) await lockProjectVersions(tx, projectId);
}

const idsIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];

/**
 * Every versioned release run of the project the rule decides over, `except` the one being cut: a
 * release batch's, and a recorded release's — a landing (`recorded-landing.ts:recordLanding`) or a
 * release performed by hand (`recorded.ts:recordPerformedRelease`) — which takes the next version as
 * any release does, so none of them hands out one number twice.
 */
export async function readLineageRuns(
  executor: Pick<Tx, 'execute'>,
  projectId: string,
  except: string | null = null,
): Promise<LineageRun[]> {
  const rows = await executor.execute<{
    id: string;
    release_version: string;
    status: string;
    started_at: Date | string;
    finished_at: Date | string | null;
    release_released_at: Date | string | null;
    metadata: Record<string, unknown> | null;
    reached_box: boolean;
    has_job: boolean;
  }>(sql`
    SELECT r.id, r.release_version, r.status, r.started_at, r.finished_at, r.release_released_at, r.metadata,
           EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id
                     AND (j.dispatched_at IS NOT NULL OR j.held_by IS NOT NULL)) AS reached_box,
           EXISTS (SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id) AS has_job
    FROM pipeline_runs r
    WHERE r.project_id = ${projectId}
      AND r.release_version IS NOT NULL
      AND r.metadata ->> 'source' IN ('release-batch', ${RELEASE_RECORD_SOURCE})
      AND (${except}::uuid IS NULL OR r.id <> ${except}::uuid)
  `);
  return rows.map((r) => {
    const metadata = r.metadata ?? {};
    return {
      id: r.id,
      version: r.release_version,
      startedAt: new Date(r.started_at),
      status: r.status,
      releasedAt: r.release_released_at === null ? null : new Date(r.release_released_at),
      endedAt: r.finished_at === null ? null : new Date(r.finished_at),
      roster: idsIn(metadata.issueIds),
      reachedBox: r.reached_box,
      hasJob: r.has_job,
      metadata,
    };
  });
}

/** Every release's attempts on this project, as the read model shows them. */
export async function readLineage(projectId: string) {
  const runs = await readLineageRuns(db, projectId);
  return { runs, ...lineageOf(runs) };
}

export async function releaseLineOf(projectId: string): Promise<PrereleaseLine | null> {
  const declared = (await readProjectDocument(projectId))?.document.release?.prerelease;
  const of = declared ? parseReleaseVersion(declared.of) : null;
  return declared && of ? { of, label: declared.label } : null;
}

/** The version a cut of `roster` would wear now, and how it was decided. Reads only. */
export async function decideRosterVersion(
  projectId: string,
  roster: readonly string[],
): Promise<VersionDecision> {
  const [runs, line] = await Promise.all([
    readLineageRuns(db, projectId),
    releaseLineOf(projectId),
  ]);
  return decideVersion(runs, roster, line);
}

/** One release whose ship stamp is set (`pipeline_runs.release_released_at`), as the serving rule reads it. */
export interface StampedRelease {
  runId: string;
  version: string;
  /** When its row was stamped shipped: for a recorded release, when the record was written. */
  at: Date;
  /** When its run was cut (`pipeline_runs.started_at`), from which it claims what it carries. */
  openedAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Every release of the project whose ship stamp is set, in stamp order (oldest first). Read once per
 * read request (`db/read-memo.ts:memoizedRead`): the serving release and the released line both ask
 * it, and a cross-project read asks both for every project.
 */
export function readStampedReleases(projectId: string): Promise<StampedRelease[]> {
  return memoizedRead(`stampedReleases:${projectId}`, async () => {
    const rows = await db.execute<{
      id: string;
      release_version: string;
      release_released_at: Date | string;
      started_at: Date | string;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT r.id, r.release_version, r.release_released_at, r.started_at, r.metadata
      FROM pipeline_runs r
      WHERE r.project_id = ${projectId}
        AND r.release_version IS NOT NULL
        AND r.release_released_at IS NOT NULL
      ORDER BY r.release_released_at ASC, r.id ASC
    `);
    return rows.map((r) => ({
      runId: r.id,
      version: r.release_version,
      at: new Date(r.release_released_at),
      openedAt: new Date(r.started_at),
      metadata: r.metadata ?? {},
    }));
  });
}

/**
 * The release production serves, among `stamped` (ISS-907, FB-481): the highest version by release
 * order (`version.ts:compareReleaseVersions`, so `0.4.0-dev.10` outranks `0.4.0-dev.9` and a
 * prerelease sits below the release it previews), never the one stamped last. A stamp on a recorded
 * release is when its record was written, so a backfill of an older version written after a newer one
 * would otherwise displace it. A landing recorded on a branch production does not deploy from deployed
 * nothing, so it is never the answer (`versions.ts:landedOffProduction`). Every reader of "current"
 * asks this, and nothing else: `currentReleaseVersion` and `released-line.ts:releasedLineOf`.
 */
export function servingRelease<T extends Pick<StampedRelease, 'version' | 'metadata'>>(
  stamped: readonly T[],
  deploysFrom: string | null,
): T | null {
  let best: { row: T; parsed: ReleaseVersion } | null = null;
  for (const row of stamped) {
    if (landedOffProduction(row.metadata, deploysFrom) !== null) continue;
    const parsed = parseReleaseVersion(row.version);
    // `pipeline_runs_release_version_chk` holds the column to this shape, so a miss is a broken row
    if (!parsed) {
      throw new Error(
        `release ${JSON.stringify(row.version)} is stamped shipped and is no release version (${RELEASE_VERSION_SHAPE}): pipeline_runs_release_version_chk should have refused it`,
      );
    }
    if (!best || compareReleaseVersions(parsed, best.parsed) > 0) best = { row, parsed };
  }
  return best?.row ?? null;
}

/**
 * The version production serves (`servingRelease`). A project whose document declares no production
 * environment has nothing serving production that Forge read, so none.
 */
export async function currentReleaseVersion(projectId: string): Promise<string | null> {
  const read = await readReleasePath(projectId);
  const production = read.ok ? read.path.production : null;
  if (!production) return null;
  const stamped = await readStampedReleases(projectId);
  return servingRelease(stamped, production.declaration.deploysFrom ?? null)?.version ?? null;
}

/** The details `RELEASE_VERSION_UNDECIDED` is composed from, at every door that reads it. */
export function undecidedDetails(
  projectId: string,
  d: Extract<VersionDecision, { kind: 'undecided' }>,
  chain: readonly LineageRun[],
): Record<string, unknown> {
  const at = chain.findIndex((r) => r.id === d.silent.id);
  return {
    projectId,
    version: d.version,
    runId: d.silent.id,
    attempt: at === -1 ? d.attempt - 1 : at + 1,
  };
}

/** A decision that names no version to wear, refused by its own rule's name. Nothing is cut. */
function refuseDecision(
  projectId: string,
  d: Exclude<VersionDecision, { kind: 'first' | 'reused' | 'bumped' }>,
  runs: readonly LineageRun[],
): never {
  if (d.kind === 'undecided') {
    const { headOf, attemptsOf } = lineageOf(runs);
    const chain = attemptsOf.get(headOf.get(d.recutOf.id)?.id ?? d.recutOf.id) ?? [d.recutOf];
    throw blockerRefusal('RELEASE_VERSION_UNDECIDED', undecidedDetails(projectId, d, chain));
  }
  if (d.kind === 'exhausted') {
    throw refuseRelease(
      'RELEASE_VERSION_EXHAUSTED',
      `the next version for project ${projectId} would be ${formatReleaseVersion(d.next)}, and a ` +
        'release version holds at most nine digits per component. Nothing was cut. Raise the ' +
        'major digit by hand on the next release row to start a fresh sequence.',
    );
  }
  // A prerelease line declared below what this project already claimed would hand out a lower
  // version after a higher one; the line is the operator's to raise, never skipped forward here.
  throw refuseRelease(
    'RELEASE_VERSION_LINE_BEHIND',
    `the next version for project ${projectId} would be ${formatReleaseVersion(d.next)}, and this ` +
      `project already claimed ${formatReleaseVersion(d.highest)}. Nothing was cut. Raise ` +
      '`release.prerelease.of` in the project document to the release the line now previews.',
  );
}

interface CutReleaseVersionArgs {
  runId: string;
  projectId: string;
  /** The roster the run was cut with: what decides whether this is a re-cut. */
  issueIds: readonly string[];
}

/**
 * The only writer of `pipeline_runs.release_version`. Called on the executor that inserted the
 * release row, so no committed release row ever exists without a version; the rule it was given is
 * written beside it (`metadata.versionCut`) in the same unit, so the page reads why, never guesses.
 */
export async function cutReleaseVersion(tx: Tx, args: CutReleaseVersionArgs): Promise<string> {
  const { runId, projectId, issueIds } = args;
  await lockProjectVersions(tx, projectId);

  const [runs, line] = await Promise.all([
    readLineageRuns(tx, projectId, runId),
    releaseLineOf(projectId),
  ]);
  const decision = decideVersion(runs, issueIds, line);
  if (decision.kind !== 'first' && decision.kind !== 'reused' && decision.kind !== 'bumped') {
    refuseDecision(projectId, decision, runs);
  }
  const { version } = decision;
  if (!(await stampReleaseVersion(runId, version, tx))) throw versionConflict(projectId, version);
  await writeRunMetadata(runId, { merge: { versionCut: cutRecordOf(decision) }, touch: false }, tx);
  return version;
}

/** `v1.31.1` or `1.31.1`, as an agent names the release it shipped, in the stored shape; null where
 *  it is no release version. */
export function givenReleaseVersion(text: string): string | null {
  const parsed = parseReleaseVersion(text.trim().replace(/^v/i, ''));
  return parsed && isStorableReleaseVersion(parsed) ? formatReleaseVersion(parsed) : null;
}

/**
 * Write the version an agent says it released onto a recorded release (owner, 2026-11-01: a release
 * is the agent's record under an explicit version). Forge decides nothing here: it refuses a version
 * another release of this project still wears, by name, and keeps the agent's number otherwise.
 */
export async function takeGivenVersion(
  tx: Tx,
  args: { runId: string; projectId: string; version: string },
): Promise<string> {
  const { runId, projectId, version } = args;
  await lockProjectVersions(tx, projectId);
  const worn = await tx.execute<{ id: string }>(sql`
    SELECT id FROM pipeline_runs
    WHERE project_id = ${projectId} AND release_version = ${version} AND id <> ${runId}
      AND (release_released_at IS NOT NULL OR status NOT IN ('cancelled', 'failed'))
    LIMIT 1
  `);
  if (worn[0]) {
    throw refuseRelease(
      'RELEASE_RECORD_VERSION_TAKEN',
      `release ${version} is already on record for this project (run ${worn[0].id}): record this release under the version it shipped as.`,
      '/version',
    );
  }
  if (!(await stampReleaseVersion(runId, version, tx))) throw versionConflict(projectId, version);
  const given: VersionCutRecord = {
    decided: 'given',
    recutOf: null,
    from: null,
    attempt: 1,
    carriers: [],
    line: null,
    takenBy: null,
    overtakenBy: null,
  };
  await writeRunMetadata(runId, { merge: { versionCut: given }, touch: false }, tx);
  return version;
}
