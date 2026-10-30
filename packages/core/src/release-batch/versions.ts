import type { VersionStatus } from '@forge/contracts/releases';
import { asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ReleaseAttemptRow, releaseAttempts } from '../db/schema-release-ledger.js';
import { type ReleaseRunRow, releaseRunsByVersion } from '../pipeline/index.js';
import type { ApprovalView } from './approvals.js';
import { RELEASE_RECORD_SOURCE } from './claim-conflicts.js';
import { LANDED_VERIFICATION } from './landed-build.js';
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

const idsIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];

/**
 * The issues a release carries: the roster it was cut with, then each it closed afterwards
 * (`metadata.rosterClosed`), less each its finish could not close (`rosterUnclosed`) — the row its agent recorded that release as shipping
 * (`shipped-in.ts`) is that release's, though it was never on its roster.
 */
export const issueIdsOf = (meta: Record<string, unknown>): string[] => {
  const closed = idsIn(meta.rosterClosed);
  // a roster issue the finish could not close was not carried by that release (ISS-811)
  const unclosed = new Set(idsIn(meta.rosterUnclosed).filter((id) => !closed.includes(id)));
  return [...new Set([...idsIn(meta.issueIds).filter((id) => !unclosed.has(id)), ...closed])];
};

/**
 * The branch a recorded landing put its release on, where production does not deploy from that
 * branch; null for every other run. Such a release landed and nothing deployed it: no production
 * reading says production serves it (`recorded-landing.ts`), so it reads `landed`, never `shipped`.
 * `deploysFrom` is the branch the project's production environment deploys from, read from
 * its document; null where it declares none.
 */
export function landedOffProduction(
  metadata: Record<string, unknown>,
  deploysFrom: string | null,
): string | null {
  if (metadata.source !== RELEASE_RECORD_SOURCE) return null;
  if (metadata.verification !== LANDED_VERIFICATION) return null;
  const branch = typeof metadata.branch === 'string' ? metadata.branch : null;
  if (branch === null) {
    throw new Error(
      `release record ${JSON.stringify(metadata.identity ?? null)} records a landing with no branch: a landing is recorded on the branch it landed on (recorded-landing.ts)`,
    );
  }
  return branch === deploysFrom ? null : branch;
}

// a version's status is read from what the run recorded, in this order: a ship stamp is final (a recorded landing off production's branch reads landed), an open run is waiting on its approval or still at work, and a concluded run was aborted or failed
// on a project that requires approval, an open run nobody has asked for approval yet waits on it too: no production act is taken before one
export function versionStatus(
  run: Pick<ReleaseRunRow, 'status' | 'releasedAt' | 'metadata'>,
  latest: Pick<ApprovalView, 'decision'> | null,
  required = false,
  deploysFrom: string | null = null,
): VersionStatus {
  if (run.releasedAt) {
    return landedOffProduction(run.metadata, deploysFrom) === null ? 'shipped' : 'landed';
  }
  if (run.status === 'running' || run.status === 'paused') {
    if (latest && latest.decision === null) return 'awaiting_approval';
    if (!latest && required) return 'awaiting_approval';
    if (latest?.decision === 'returned') return 'returned';
    return 'in_progress';
  }
  if (run.metadata.abort) return 'aborted';
  return 'failed';
}
