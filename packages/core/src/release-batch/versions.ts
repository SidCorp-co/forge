import type { VersionStatus } from '@forge/contracts/releases';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { type ReleaseAttemptRow, releaseAttempts } from '../db/schema-release-ledger.js';
import type { ApprovalView } from './approvals.js';
import { compareReleaseVersions, parseReleaseVersion } from './version.js';

export interface RunRow {
  id: string;
  status: string;
  version: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  releasedAt: Date | null;
}

export async function versionRuns(projectId: string, version?: string): Promise<RunRow[]> {
  const rows = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
      startedAt: pipelineRuns.startedAt,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.releaseVersion} IS NOT NULL`,
        sql`${pipelineRuns.metadata}->>'source' = 'release-batch'`,
        ...(version ? [eq(pipelineRuns.releaseVersion, version)] : []),
      ),
    );
  return latestPerVersion(
    rows.map((r) => ({
      ...r,
      version: r.version as string,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    })),
  ).sort((a, b) => byVersionDescending(a.version, b.version));
}

/**
 * One row per version: the newest run wearing it. A number an ended batch handed back is worn again
 * by the next batch (`version-store.ts:highestSpentVersion`), so the version history names what that
 * number became; the earlier attempt keeps it on its own row and reads at its run.
 */
function latestPerVersion(rows: RunRow[]): RunRow[] {
  const byVersion = new Map<string, RunRow>();
  for (const row of rows) {
    const held = byVersion.get(row.version);
    if (!held || row.startedAt > held.startedAt) byVersion.set(row.version, row);
  }
  return [...byVersion.values()];
}

// cm:why the column CHECK makes every stored version parse; one that did not would sort last rather
// than throw out of a read that lists releases.
function byVersionDescending(a: string, b: string): number {
  const [va, vb] = [parseReleaseVersion(a), parseReleaseVersion(b)];
  if (!va || !vb) return (va ? -1 : 0) + (vb ? 1 : 0);
  return compareReleaseVersions(vb, va);
}

export async function attemptsOf(runIds: readonly string[]): Promise<ReleaseAttemptRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(releaseAttempts)
    .where(inArray(releaseAttempts.runId, [...runIds]))
    .orderBy(asc(releaseAttempts.startedAt), asc(releaseAttempts.id));
}

export const issueIdsOf = (meta: Record<string, unknown>): string[] =>
  Array.isArray(meta.issueIds)
    ? meta.issueIds.filter((x): x is string => typeof x === 'string')
    : [];

// cm:why a version's status is read from what the run recorded, in this order: a ship stamp is final, an open run is waiting on its approval or still at work, and a concluded run was aborted or failed
// cm:why on a project that requires approval, an open run nobody has asked for approval yet waits on it too: no production act is taken before one
export function versionStatus(
  run: Pick<RunRow, 'status' | 'releasedAt' | 'metadata'>,
  latest: Pick<ApprovalView, 'decision'> | null,
  required = false,
): VersionStatus {
  if (run.releasedAt) return 'shipped';
  if (run.status === 'running' || run.status === 'paused') {
    if (latest && latest.decision === null) return 'awaiting_approval';
    if (!latest && required) return 'awaiting_approval';
    if (latest?.decision === 'returned') return 'returned';
    return 'in_progress';
  }
  if (run.metadata.abort) return 'aborted';
  return 'failed';
}
