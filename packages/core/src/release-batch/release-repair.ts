// A release that ended `failed` though it did ship, settled to what happened by a person's recorded
// act (ISS-761; catalog-api 0.4.0, 2026-10-29: failed with no reason, its verify attempt ok and its
// deploy healthy). The act writes who, when, why and the evidence they name beside the failure it
// settles, which stays on the run: nothing is rewritten, so the release reads `shipped` and says
// how it came to. Forge reads no probe and no deployment record here: the evidence is the person's
// word, kept (owner rule `release-is-the-agents-record`).

import type { ReleaseRepairView } from '@forge/contracts/releases';
import { and, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { releaseRunsByVersion, stampReleaseShipped, writeRunMetadata } from '../pipeline/index.js';
import { refuseRelease } from './refuse.js';
import { type RepairedRoster, settleRepairedRoster } from './repaired-roster.js';
import { versionStatus } from './versions.js';

/** The repair a run keeps (`metadata.repair`), as written. */
export interface ReleaseRepairRecord {
  outcome: 'shipped';
  by: string;
  at: string;
  reason: string;
  evidence: string;
  was: { status: string; failureCode: string | null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The repair a run's metadata carries, or null where none was recorded: the one reader of it. */
export function readReleaseRepair(metadata: unknown): ReleaseRepairRecord | null {
  const raw = (metadata as { repair?: unknown } | null)?.repair;
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const was = (typeof r.was === 'object' && r.was !== null ? r.was : {}) as Record<string, unknown>;
  const by = str(r.by);
  const at = str(r.at);
  if (r.outcome !== 'shipped' || !by || !at) return null;
  return {
    outcome: 'shipped',
    by,
    at,
    reason: str(r.reason) ?? '',
    evidence: str(r.evidence) ?? '',
    was: { status: str(was.status) ?? '', failureCode: str(was.failureCode) },
  };
}

/** The repair as the release page shows it, its actor resolved by the caller. */
export function repairViewOf(
  record: ReleaseRepairRecord,
  by: ReleaseRepairView['by'],
): ReleaseRepairView {
  return { ...record, by };
}

/** The failure a run's close recorded (`pipeline/runs-cascade.ts:failureMetadata`), or null. */
export function readRunFailure(
  metadata: unknown,
): { code: string; detail: string; step: string | null } | null {
  const raw = (metadata as { failure?: unknown } | null)?.failure;
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const code = str(f.code);
  const detail = str(f.detail);
  if (!code || !detail) return null;
  return { code, detail, step: str(f.step) };
}

export interface RepairReleaseArgs {
  projectId: string;
  version: string;
  userId: string;
  reason: string;
  evidence: string;
}

/**
 * Record that a release which reads `failed` shipped: its ship stamped, and the repair written beside
 * the failure it settles, in one unit. Refused by name for a version no release wears, and for one
 * that does not read `failed` — shipped already, aborted by a person, or still open. Shipped, it
 * settles its roster (`repaired-roster.ts`); a release repaired before, asked again, only settles
 * what its roster still owes (ISS-900, catalog-api ISS-34).
 */
export async function repairRelease(args: RepairReleaseArgs): Promise<{
  runId: string;
  version: string;
  repair: ReleaseRepairRecord;
  roster: RepairedRoster;
  /** True where the release was repaired before: this call only settled its roster again. */
  repeated: boolean;
}> {
  const { projectId, version, userId, reason, evidence } = args;
  const [run] = await releaseRunsByVersion(projectId, version);
  if (!run) {
    throw refuseRelease(
      'RELEASE_REPAIR_UNKNOWN',
      `No release of this project wears ${version}: name the version the release page shows.`,
      '/version',
    );
  }
  const state = versionStatus(run, null);
  const rosterOf = () => {
    const ids = ((run.metadata ?? {}) as { issueIds?: unknown }).issueIds;
    const roster = (Array.isArray(ids) ? ids : []).filter(
      (id): id is string => typeof id === 'string',
    );
    return settleRepairedRoster({ projectId, runId: run.id, roster, userId, evidence });
  };
  // a repaired release asked again settles what its roster still owes, writing no second repair:
  // repaired is its repair kept and its ship stamped, whether it reads `shipped` or `landed`, and
  // whichever build wrote that repair (ISS-761's settled no roster). One shipped unrepaired is refused.
  const prior = readReleaseRepair(run.metadata);
  if (prior && run.releasedAt) {
    return { runId: run.id, version, repair: prior, roster: await rosterOf(), repeated: true };
  }
  if (state !== 'failed') {
    throw refuseRelease(
      'RELEASE_REPAIR_NOT_FAILED',
      `Release ${version} reads \`${state}\`, not \`failed\`: only a release that ended failed is repaired to shipped. An aborted one was a person's decision, an open one is still finishing, and a shipped one needs nothing.`,
      '/version',
    );
  }
  const record: ReleaseRepairRecord = {
    outcome: 'shipped',
    by: userId,
    at: new Date().toISOString(),
    reason,
    evidence,
    was: { status: run.status, failureCode: readRunFailure(run.metadata)?.code ?? null },
  };
  const wrote = await db.transaction(async (tx) => {
    const moved = await writeRunMetadata(
      run.id,
      {
        value: sql`coalesce(${pipelineRuns.metadata}, '{}'::jsonb) || jsonb_build_object('repair', ${JSON.stringify(record)}::jsonb)`,
        when: and(
          isNull(pipelineRuns.releaseReleasedAt),
          sql`${pipelineRuns.status} = ${run.status}`,
          sql`${pipelineRuns.metadata} -> 'repair' IS NULL`,
        ),
        touch: true,
      },
      tx,
    );
    if (moved) await stampReleaseShipped(run.id, tx);
    return moved;
  });
  if (!wrote) {
    throw refuseRelease(
      'RELEASE_REPAIR_NOT_FAILED',
      `Release ${version} changed while this repair was written: read it again, and repair it only if it still reads \`failed\`.`,
      '/version',
    );
  }
  // shipped now, it settles its roster as its finish would have (`repaired-roster.ts`)
  return { runId: run.id, version, repair: record, roster: await rosterOf(), repeated: false };
}
