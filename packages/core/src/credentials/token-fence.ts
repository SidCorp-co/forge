import { and, inArray, isNotNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { patIsLive } from './pat-live.js';

/**
 * The projects a token reaches: a list, or null where it carries no fence and reaches every project
 * its holder can see. An empty list reaches nothing. This is the one reading of
 * `personal_access_tokens.bound_project_id` and `project_ids`: the REST door, the MCP door, the box's
 * WebSocket door and pool admission all ask it (FB-78).
 */
export type TokenFence = readonly string[] | null;

/** A token row's fence: its bound project alone, else its project list, null being no fence. */
export function tokenFence(row: {
  boundProjectId: string | null;
  projectIds: readonly string[] | null;
}): TokenFence {
  if (row.boundProjectId) return [row.boundProjectId];
  return row.projectIds;
}

export function fenceReaches(fence: TokenFence, projectId: string): boolean {
  return fence === null || fence.includes(projectId);
}

/** The fence as a WHERE condition over a project id column; null where it fences nothing. */
export function fenceWhere(projectId: SQLWrapper, fence: TokenFence): SQL | null {
  if (fence === null) return null;
  return fence.length > 0 ? inArray(projectId, [...fence]) : sql`false`;
}

/** What several tokens reach together: every project where any is unfenced. */
function unionFence(fences: readonly TokenFence[]): TokenFence {
  if (fences.some((f) => f === null)) return null;
  return [...new Set(fences.flatMap((f) => f ?? []))];
}

/**
 * What each box's live credentials reach together, asked by device id. A box with no live
 * credential, or one not asked about, reaches nothing. Answered as a function rather than a map, so
 * no caller reads a missing entry with `??` and turns the unfenced `null` into `[]`.
 */
export async function deviceReach(
  deviceIds: readonly string[],
): Promise<(deviceId: string) => TokenFence> {
  const ids = [...new Set(deviceIds)];
  const out = new Map<string, TokenFence>();
  const reachOf = (deviceId: string): TokenFence => {
    const fence = out.get(deviceId);
    return fence === undefined ? [] : fence;
  };
  if (ids.length === 0) return reachOf;
  const rows = await db
    .select({
      deviceId: personalAccessTokens.deviceId,
      boundProjectId: personalAccessTokens.boundProjectId,
      projectIds: personalAccessTokens.projectIds,
    })
    .from(personalAccessTokens)
    .where(
      and(
        isNotNull(personalAccessTokens.deviceId),
        inArray(personalAccessTokens.deviceId, ids),
        patIsLive(),
      ),
    );
  const byDevice = new Map<string, TokenFence[]>();
  for (const row of rows) {
    const id = row.deviceId as string;
    byDevice.set(id, [...(byDevice.get(id) ?? []), tokenFence(row)]);
  }
  for (const [id, fences] of byDevice) out.set(id, unionFence(fences));
  return reachOf;
}
