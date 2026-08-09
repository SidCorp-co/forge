import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, skillActivityEvents } from '../db/schema.js';
import { logger } from '../logger.js';
import {
  type PlatformInvariantEntry,
  buildPlatformInvariantSet,
  describeInvariantDelta,
} from '../prompt/facts/invariant-set.js';
import { recordSkillActivityEvent } from './activity.js';

// Stage ① producer (ISS-795 §2). Without this, `policy.landed` had a reader
// and no writer: `reconcile-service.assembleBundle()` item 11 was always empty,
// so the verifier's hard constraint was permanently null and "stage ① binds
// stage ②" never actually held.
//
// Runs at boot, next to seedBuiltinSkills — the invariant set lives in code, so
// a deploy is exactly when it can change.

export interface PolicyLandedSweepResult {
  digest: string;
  projectsStamped: number;
  changed: boolean;
}

/** Latest recorded snapshot for a project, or null when it has never been stamped. */
async function lastSnapshotFor(
  projectId: string,
): Promise<{ digest: string; entries: PlatformInvariantEntry[] } | null> {
  const [row] = await db
    .select({ afterHash: skillActivityEvents.afterHash, reason: skillActivityEvents.reason })
    .from(skillActivityEvents)
    .where(
      and(
        eq(skillActivityEvents.eventType, 'policy.landed'),
        eq(skillActivityEvents.projectId, projectId),
      ),
    )
    .orderBy(desc(skillActivityEvents.occurredAt))
    .limit(1);

  if (!row?.afterHash) return null;
  return { digest: row.afterHash, entries: parseEntries(row.reason) };
}

// cm:edge contract -> packages/core/src/prompt/facts/invariant-set.ts#buildPlatformInvariantSet — parses the `id vN (sha)` shape that function's `summary` emits; change the format there and the delta silently degrades to "added" for every entry
const ENTRY_RE = /([a-z0-9-]+) v(\d+) \(([0-9a-f]{8})\)/g;

function parseEntries(reason: string | null): PlatformInvariantEntry[] {
  if (!reason) return [];
  const out: PlatformInvariantEntry[] = [];
  for (const m of reason.matchAll(ENTRY_RE)) {
    out.push({ id: m[1] as string, title: '', version: Number(m[2]), sha: m[3] as string });
  }
  return out;
}

/**
 * Stamp one project if its recorded digest is missing or stale, and report
 * whether a row was written.
 *
 * Split out so a reconcile can self-heal: the boot sweep only sees projects
 * that existed at boot, so a project created afterwards would carry an empty
 * bundle item 11 until the next deploy.
 */
export async function ensurePolicyLandedFor(projectId: string): Promise<boolean> {
  const set = buildPlatformInvariantSet();
  const previous = await lastSnapshotFor(projectId);
  if (previous?.digest === set.digest) return false;

  // cm:guard one row per project, not one global row — assembleBundle reads `policy.landed`
  // scoped to its project, so a global-only stamp would leave every bundle's item 11 empty
  await db.transaction(async (tx) => {
    await recordSkillActivityEvent(tx, {
      eventType: 'policy.landed',
      actor: 'system:seeder',
      trigger: 'deploy',
      projectId,
      ...(previous ? { beforeHash: previous.digest } : {}),
      afterHash: set.digest,
      reason: set.summary,
      deltaSummary: describeInvariantDelta(previous ? previous.entries : null, set.entries),
    });
  });
  return true;
}

/**
 * Stamp `policy.landed` on every project whose recorded invariant digest no
 * longer matches the code. Idempotent: a boot that changes nothing writes
 * nothing (§7 principle 1 — the log records transitions, not passes).
 *
 * Never throws: a sweep problem must not fail boot.
 */
export async function sweepPolicyLanded(): Promise<PolicyLandedSweepResult> {
  const set = buildPlatformInvariantSet();
  const result: PolicyLandedSweepResult = {
    digest: set.digest,
    projectsStamped: 0,
    changed: false,
  };

  try {
    const rows = await db.select({ id: projects.id }).from(projects);

    for (const project of rows) {
      if (await ensurePolicyLandedFor(project.id)) result.projectsStamped += 1;
    }

    result.changed = result.projectsStamped > 0;
    logger.info(
      { digest: set.digest, projectsStamped: result.projectsStamped },
      'policy-landed: invariant sweep complete',
    );
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'policy-landed: sweep failed');
  }

  return result;
}
