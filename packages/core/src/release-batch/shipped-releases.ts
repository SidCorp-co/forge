// The releases a project shipped, as Forge recorded them: a release-batch run whose finish reads
// `finished`, whose ship stamp is set, and whose `finish.commit` is the commit it shipped, as its
// finish named it, its deploy reported it or its agent attached it (`shipped-commit.ts`, ISS-1079).
// Read from Forge's own rows only; no source host is asked.

import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { reportedCommit } from './verify.js';
import { issueIdsOf } from './versions.js';

/** A release Forge verified shipping: the version it cut and the commit production served. */
export interface ShippedRelease {
  runId: string;
  version: string;
  commit: string;
}

/** A shipped release with the issues it carries (`versions.ts:issueIdsOf`) and when it was cut. */
export interface ShippedReleaseRun extends ShippedRelease {
  issueIds: string[];
  cutAt: Date;
}

/**
 * Releases that shipped, oldest first, each with the issues it carries. With `built`, only those
 * whose commit a deployment reporting `built` confirms (`verify.ts:deploymentConfirms`), asked of
 * the database, so a read of the one release a build is never reads every release's record.
 */
export async function shippedReleaseRuns(
  projectId: string,
  opts: { built?: string | null } = {},
): Promise<ShippedReleaseRun[]> {
  const reading = opts.built === undefined ? undefined : reportedCommit(opts.built ?? '');
  if (reading === null) return [];
  const rows = await db
    .select({
      runId: pipelineRuns.id,
      version: pipelineRuns.releaseVersion,
      commit: sql<string | null>`${pipelineRuns.metadata} -> 'finish' ->> 'commit'`,
      metadata: pipelineRuns.metadata,
      cutAt: pipelineRuns.createdAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.metadata} ->> 'source' = 'release-batch'`,
        sql`${pipelineRuns.metadata} -> 'finish' ->> 'state' = 'finished'`,
        isNotNull(pipelineRuns.releaseVersion),
        isNotNull(pipelineRuns.releaseReleasedAt),
        ...(reading
          ? [
              sql`lower(btrim(${pipelineRuns.metadata} -> 'finish' ->> 'commit')) LIKE ${`${reading}%`}`,
            ]
          : []),
      ),
    )
    .orderBy(asc(pipelineRuns.releaseReleasedAt), asc(pipelineRuns.id));
  return rows.flatMap((r) =>
    r.version && r.commit && /^[0-9a-f]{40}$/i.test(r.commit)
      ? [
          {
            runId: r.runId,
            version: r.version,
            commit: r.commit.toLowerCase(),
            issueIds: issueIdsOf((r.metadata ?? {}) as Record<string, unknown>),
            cutAt: r.cutAt,
          },
        ]
      : [],
  );
}

const WHOLE = /^[0-9a-f]{40}$/i;
const MIN_ABBREVIATION = 7;

/**
 * The releases, oldest first, Forge recorded shipping at `sha`: whole, or an abbreviation of exactly
 * one release commit. Empty where none did, so a sentence about a served commit says what it is
 * (ISS-997) and never that no release shipped one a release did.
 */
export function releasesAt<R extends ShippedRelease>(sha: string, releases: readonly R[]): R[] {
  const s = sha.trim().toLowerCase();
  if (WHOLE.test(s)) return releases.filter((r) => r.commit === s);
  if (s.length < MIN_ABBREVIATION) return [];
  const named = releases.filter((r) => r.commit.startsWith(s));
  return new Set(named.map((r) => r.commit)).size === 1 ? named : [];
}
