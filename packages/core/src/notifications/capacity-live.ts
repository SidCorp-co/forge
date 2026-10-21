// A capacity notice is worded when it is raised and read for as long as it stands; the runners it
// counts come and go in between. Its words are taken again from the fleet each time it is read, so
// "both of its runners are online" is never read after one went offline (ISS-1228).

import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, notifications } from '../db/schema.js';
import { capacityCopy, capacityScope, readCapacityFleet } from '../jobs/capacity-fleet.js';
import { resolveStageOverrides } from '../jobs/stage-overrides.js';
import { wedgeBody } from '../pipeline/wedge-words.js';
import type { RequiredCapabilities } from '../runners/types.js';

const CAPACITY_KEY = 'wedge:capacity:';

export interface LiveWords {
  title: string;
  body: string;
}

/** `wedge:capacity:<projectId>:<stageKey>`, as `capacityWedgeEntityId` writes it under the wedge key. */
function capacityKeyParts(key: string): { projectId: string; stageKey: string } | null {
  const rest = key.startsWith(CAPACITY_KEY) ? key.slice(CAPACITY_KEY.length) : null;
  const at = rest?.indexOf(':') ?? -1;
  if (!rest || at <= 0) return null;
  return { projectId: rest.slice(0, at), stageKey: rest.slice(at + 1) };
}

/** The subject the delivery put before the notice's own title ("ISS-1 — "), kept as it was told. */
function subjectOf(stored: string): string {
  const at = stored.search(/No (capacity:|runner can take)/);
  return at > 0 ? stored.slice(0, at) : '';
}

/** What the step the notice is about waits with: the newest queued job of its pool, its issue's first. */
async function waitingStep(
  projectId: string,
  stageKey: string,
  issueId: string | null,
): Promise<{ required: RequiredCapabilities | undefined; pool: string[] | null } | null> {
  const ofPool = stageKey === 'all' ? sql`true` : sql`${jobs.type} = ${stageKey}`;
  const [job] = await db
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.status, 'queued'), ofPool))
    .orderBy(
      ...(issueId ? [desc(sql`${jobs.issueId} IS NOT DISTINCT FROM ${issueId}`)] : []),
      desc(jobs.createdAt),
    )
    .limit(1);
  if (!job) return stageKey === 'all' ? { required: undefined, pool: null } : null;
  const required = (job.payload as { requiredCapabilities?: RequiredCapabilities } | null)
    ?.requiredCapabilities;
  const pool = stageKey === 'all' ? null : (await resolveStageOverrides(projectId, job.payload)).deviceIds;
  return { required, pool };
}

/**
 * The words each open capacity notice among these records says now, by record id. A record that is
 * not an open capacity notice, or whose pool can no longer be read, is absent and keeps its words.
 */
export async function liveCapacityWords(ids: readonly string[]): Promise<Map<string, LiveWords>> {
  const told = new Map<string, LiveWords>();
  if (ids.length === 0) return told;
  const rows = await db
    .select({
      id: notifications.id,
      key: notifications.resolutionKey,
      issueId: notifications.issueId,
      title: notifications.title,
    })
    .from(notifications)
    .where(
      and(
        inArray(notifications.id, [...new Set(ids)]),
        eq(notifications.type, 'pipeline_wedge'),
        isNull(notifications.resolvedAt),
        like(notifications.resolutionKey, `${CAPACITY_KEY}%`),
      ),
    );
  for (const row of rows) {
    const parts = row.key ? capacityKeyParts(row.key) : null;
    if (!parts) continue;
    const step = await waitingStep(parts.projectId, parts.stageKey, row.issueId);
    if (!step) continue;
    const fleet = await readCapacityFleet(parts.projectId, step.required, step.pool);
    const copy = capacityCopy(fleet, { scope: capacityScope(parts.stageKey) });
    told.set(row.id, {
      title: `${subjectOf(row.title)}${copy.title}`,
      body: wedgeBody(copy.summary, copy.nextStep),
    });
  }
  return told;
}
