import type { VersionStatus } from '@forge/contracts/releases';
import { asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ReleaseAttemptRow, releaseAttempts } from '../db/schema-release-ledger.js';
import { type ReleaseRunRow, releaseRunsByVersion } from '../pipeline/index.js';
import type { ApprovalView } from './approvals.js';
import { compareReleaseVersions, parseReleaseVersion } from './version.js';

export async function versionRuns(projectId: string, version?: string): Promise<ReleaseRunRow[]> {
  return (await releaseRunsByVersion(projectId, version)).sort((a, b) =>
    byVersionDescending(a.version, b.version),
  );
}

// the column CHECK makes every stored version parse; one that did not would sort last rather
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

// a version's status is read from what the run recorded, in this order: a ship stamp is final, an open run is waiting on its approval or still at work, and a concluded run was aborted or failed
// on a project that requires approval, an open run nobody has asked for approval yet waits on it too: no production act is taken before one
export function versionStatus(
  run: Pick<ReleaseRunRow, 'status' | 'releasedAt' | 'metadata'>,
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
