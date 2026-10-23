// The assistant's draft of a release's name as kept while it is owed or refused (REQ-40 BC-14):
// `release_naming_drafts`, read by the page to say where the name stands and written only by the
// namer (`naming-refresh.ts`).

import type { Refusal } from '@forge/contracts/refusal';
import type { ReleaseNamingStanding } from '@forge/contracts/release-naming';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ReleaseNamingDraftRow, releaseNamingDrafts } from '../db/schema.js';

/** A draft claimed this long ago and never settled is taken over by the next trigger. */
const IN_FLIGHT_MS = 5 * 60_000;
/** A refused or unanswered draft is tried again no sooner than this. */
const RETRY_MS = 10 * 60_000;

/** Whether a kept draft may be taken over: one in flight past its window, or a refusal past its retry. */
export function namingDraftStale(row: ReleaseNamingDraftRow, now: Date = new Date()): boolean {
  const age = now.getTime() - row.updatedAt.getTime();
  return age > (row.state === 'drafting' ? IN_FLIGHT_MS : RETRY_MS);
}

export async function namingRow(projectId: string, version: string) {
  const [row] = await db
    .select()
    .from(releaseNamingDrafts)
    .where(
      and(eq(releaseNamingDrafts.projectId, projectId), eq(releaseNamingDrafts.version, version)),
    )
    .limit(1);
  return row ?? null;
}

export async function clearRow(projectId: string, version: string): Promise<void> {
  await db
    .delete(releaseNamingDrafts)
    .where(
      and(eq(releaseNamingDrafts.projectId, projectId), eq(releaseNamingDrafts.version, version)),
    );
}

/**
 * Claims the draft: the row goes `drafting`, unless another trigger holds a fresh claim or a refusal
 * is still inside its retry window. One statement, so two triggers at once draft once.
 */
export async function claim(projectId: string, version: string): Promise<boolean> {
  const rows = await db
    .insert(releaseNamingDrafts)
    .values({ projectId, version, state: 'drafting' })
    .onConflictDoUpdate({
      target: [releaseNamingDrafts.projectId, releaseNamingDrafts.version],
      set: { state: 'drafting', updatedAt: sql`now()` },
      setWhere: sql`(${releaseNamingDrafts.state} = 'drafting' AND ${releaseNamingDrafts.updatedAt} < now() - make_interval(secs => ${IN_FLIGHT_MS / 1000})) OR (${releaseNamingDrafts.state} = 'failed' AND ${releaseNamingDrafts.updatedAt} < now() - make_interval(secs => ${RETRY_MS / 1000}))`,
    })
    .returning({ id: releaseNamingDrafts.id });
  return rows.length > 0;
}

export async function settleFailed(
  projectId: string,
  version: string,
  refusals: Refusal[],
  model: string | null,
): Promise<void> {
  await db
    .update(releaseNamingDrafts)
    .set({ state: 'failed', refusals, model, updatedAt: sql`now()` })
    .where(
      and(eq(releaseNamingDrafts.projectId, projectId), eq(releaseNamingDrafts.version, version)),
    );
}

/** Where a release's name stands, for its page: named, owed to the assistant, or refused and why. */
export function namingStanding(
  named: boolean,
  row: ReleaseNamingDraftRow | null,
  now: Date = new Date(),
): ReleaseNamingStanding {
  if (named) return { state: 'named' };
  if (row?.state === 'failed') {
    return {
      state: 'failed',
      at: row.updatedAt.toISOString(),
      refusals: (row.refusals as Refusal[]).map((r) => ({
        code: r.code,
        path: r.path,
        detail: r.detail,
      })),
    };
  }
  return { state: 'drafting', since: (row?.updatedAt ?? now).toISOString() };
}
