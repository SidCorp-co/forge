// Which run wears a release version. Since a re-cut of a roster wears the version its earlier attempt
// wore (`release-batch/version-rule.ts:decideVersion`), several runs can carry one
// `release_version`; every reader resolves it here, so a version names one run everywhere.

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { memoizedRead } from '../db/read-memo.js';
import { pipelineRuns } from '../db/schema.js';
import { releaseRunsHoldingSql } from '../issues/index.js';

export interface ReleaseRunRow {
  id: string;
  status: string;
  version: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  releasedAt: Date | null;
}

/** Which of two runs at one version wears it: the one that shipped, else the newest. */
function wearsOver(row: ReleaseRunRow, held: ReleaseRunRow): boolean {
  if ((row.releasedAt !== null) !== (held.releasedAt !== null)) return row.releasedAt !== null;
  return row.startedAt > held.startedAt;
}

/**
 * The keys of a run's metadata its place among the releases reads (`release-batch/versions.ts:
 * versionStatus`, `landedOffProduction`): a read that places every run and shows a few reads only
 * these of each, and the whole metadata of the few (ISS-1070).
 */
const PLACING_KEYS = ['source', 'verification', 'branch', 'identity', 'abort'] as const;

const placingMetadata = sql`jsonb_build_object(${sql.join(
  PLACING_KEYS.map((k) => sql`${k}::text, ${pipelineRuns.metadata} -> ${k}::text`),
  sql`, `,
)})`;

const runColumns = (placing: boolean) => ({
  id: pipelineRuns.id,
  status: pipelineRuns.status,
  version: pipelineRuns.releaseVersion,
  metadata: placing ? sql<unknown>`${placingMetadata}` : pipelineRuns.metadata,
  startedAt: pipelineRuns.startedAt,
  releasedAt: pipelineRuns.releaseReleasedAt,
});

/**
 * One release-batch run per version, the one wearing it; every version, or just `version`. With
 * `placing`, each run's metadata holds only the keys its place reads (`PLACING_KEYS`).
 */
export async function releaseRunsByVersion(
  projectId: string,
  version?: string,
  opts: { placing?: boolean } = {},
): Promise<ReleaseRunRow[]> {
  const rows = await db
    .select(runColumns(opts.placing === true))
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.releaseVersion} IS NOT NULL`,
        // a recorded landing is a release with a version too (`release-batch/recorded-landing.ts`)
        sql`${pipelineRuns.metadata}->>'source' IN ('release-batch', 'release-record')`,
        ...(version ? [eq(pipelineRuns.releaseVersion, version)] : []),
      ),
    );
  const byVersion = new Map<string, ReleaseRunRow>();
  for (const r of rows) {
    const row = {
      ...r,
      version: r.version as string,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    };
    const held = byVersion.get(row.version);
    if (!held || wearsOver(row, held)) byVersion.set(row.version, row);
  }
  return [...byVersion.values()];
}

/** These release runs of the project, each with its whole metadata, in no order. */
export async function releaseRunsByIds(
  projectId: string,
  ids: readonly string[],
): Promise<ReleaseRunRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(runColumns(false))
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.projectId, projectId), inArray(pipelineRuns.id, [...ids])));
  return rows.map((r) => ({
    ...r,
    version: r.version as string,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** The run that wears `version` in this project, or `null` when none does. */
export async function runWearingVersion(
  projectId: string,
  version: string,
): Promise<ReleaseRunRow | null> {
  return (await releaseRunsByVersion(projectId, version))[0] ?? null;
}

/**
 * The issues a shipped-in record put on a release and a correction has since moved to the release
 * that truly shipped them (`release-batch/shipped-in-correct.ts`, ISS-846): the run keeps the record
 * under `metadata.shippedInCorrections`, and lists the issue no longer. Every reader of what a release
 * carries subtracts these.
 */
export const supersededIdsIn = (meta: Record<string, unknown>): Set<string> => {
  const list = meta.rosterSuperseded;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
};

/** The release that shipped an issue, by the version it wears and when it shipped. */
export interface ShippedRelease {
  version: string;
  at: string;
}

/**
 * The release that shipped each of `issueIds`: the latest of the shipped releases still holding its
 * work (`issues/release-evidence.ts:holdingReleaseRunsSql`): a shipped release-batch run whose roster
 * names it, or that closed it afterwards (`metadata.rosterClosed`, `release-batch/versions.ts:
 * issueIdsOf`), less one a shipped-in correction moved it off (`rosterSuperseded`), and less one that
 * shipped before the issue last left `closed`, whose work its reopen rejected. An issue no shipped
 * release holds is absent, closed or not: `closed` says its criteria were met in scope, and whether
 * its work is live is this record's to say.
 */
export async function shippedReleasesOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, ShippedRelease>> {
  if (issueIds.length === 0) return new Map();
  // a read asks it again of the same issues (the feedback list and its ship notices): once a request
  const ids = [...new Set(issueIds)].sort();
  const key = createHash('sha256').update(ids.join(',')).digest('base64url');
  return memoizedRead(`shippedReleasesOf:${projectId}:${key}`, () =>
    readShippedReleases(projectId, ids),
  );
}

async function readShippedReleases(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, ShippedRelease>> {
  const rows = rowsOf<{ issue_id: string; version: string; at: string | Date }>(
    await db.execute(sql`
      SELECT DISTINCT ON (h.issue_id) h.issue_id, h.release_version AS version, h.release_released_at AS at
        FROM (${releaseRunsHoldingSql(issueIds, sql`${projectId}::uuid`)}) h
       ORDER BY h.issue_id, h.release_released_at DESC`),
  );
  return new Map(
    rows.map((r) => [r.issue_id, { version: r.version, at: new Date(r.at).toISOString() }]),
  );
}
