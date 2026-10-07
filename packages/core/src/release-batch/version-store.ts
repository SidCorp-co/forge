// Where a release's version lives, and the only writer of it (ADR 0011).
//
// A version names a RELEASE, not an attempt. The first cut of a roster claims a version; every
// re-cut of the same roster wears it again until it ships, unless something outside Forge already
// carries it — a pushed tag, a release commit, a published artifact, a notice sent — and then the
// next attempt takes a new version and records why, naming the carrier. Which version is the rule's
// (`version-rule.ts:decideVersion`); this module reads the runs it decides over and writes the
// answer. `currentReleaseVersion` answers what is SERVING and reads the ship stamp, because
// `cancelConcludedRun` flips a `completed` run to `cancelled` while its bytes are still live. The
// partial unique index `pipeline_runs_release_version_uq` is only the backstop.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import { stampReleaseVersion, writeRunMetadata } from '../pipeline/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { blockerRefusal, refuseRelease } from './refuse.js';
import { formatReleaseVersion, type PrereleaseLine, parseReleaseVersion } from './version.js';
import {
  cutRecordOf,
  decideVersion,
  type LineageRun,
  lineageOf,
  type VersionDecision,
} from './version-rule.js';

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

/** Every release-batch run of the project the rule decides over, `except` the one being cut. */
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
      AND r.metadata ->> 'source' = 'release-batch'
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
