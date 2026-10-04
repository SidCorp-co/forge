import type { PatFence, PatFenceChangeView } from '@forge/contracts/pat-fence';
import { and, desc, eq } from 'drizzle-orm';
import { lockPatName, type Pat } from '../auth/pat.js';
import { db, type Tx } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { type PatFenceChangeRow, patFenceChanges } from '../db/schema-pat-fence-changes.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { fenceRefusals, type PatFenceRefusal, tokenStateRefusals } from './fence-rules.js';

export type SetPatFenceInput = {
  tokenId: string;
  ownerId: string;
  fence: PatFence;
  reason: string;
};

export type SetPatFenceOutcome =
  | { ok: true; token: Pat; change: PatFenceChangeView }
  | { ok: false; refusals: PatFenceRefusal[] };

export function fenceChangeView(row: PatFenceChangeRow): PatFenceChangeView {
  return {
    id: row.id,
    tokenId: row.tokenId,
    changedBy: row.changedBy,
    previous: {
      projectIds: row.previousProjectIds ?? null,
      boundProjectId: row.previousBoundProjectId ?? null,
    },
    fence: { projectIds: row.projectIds ?? null, boundProjectId: row.boundProjectId ?? null },
    reason: row.reason,
    changedAt: row.changedAt.toISOString(),
  };
}

async function ownedTokenIn(tx: Tx, tokenId: string, ownerId: string): Promise<Pat | null> {
  const [row] = await tx
    .select()
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, ownerId)))
    .limit(1);
  return row ?? null;
}

// cm:guard the fence is read under the token name's lock, the one `rotatePat` copies a fence under, so
// an edit and a rotation are ordered and a rotation never carries a fence an edit already replaced
export async function setPatFence(input: SetPatFenceInput): Promise<SetPatFenceOutcome | null> {
  const reachable = new Set(await loadVisibleProjectIds(input.ownerId));
  return db.transaction(async (tx) => {
    const seen = await ownedTokenIn(tx, input.tokenId, input.ownerId);
    if (!seen) return null;
    await lockPatName(tx, seen.name);
    const token = await ownedTokenIn(tx, input.tokenId, input.ownerId);
    if (!token) return null;

    const stateRefused = tokenStateRefusals(token, new Date());
    if (stateRefused.length > 0) return { ok: false, refusals: stateRefused };
    const refused = fenceRefusals(token, input.fence, reachable);
    if (refused.length > 0) return { ok: false, refusals: refused };

    const [updated] = await tx
      .update(personalAccessTokens)
      .set({ projectIds: input.fence.projectIds, boundProjectId: input.fence.boundProjectId })
      .where(eq(personalAccessTokens.id, token.id))
      .returning();
    if (!updated) throw new Error(`setPatFence: token ${token.id} vanished under its own lock`);

    const [change] = await tx
      .insert(patFenceChanges)
      .values({
        tokenId: token.id,
        changedBy: input.ownerId,
        previousProjectIds: token.projectIds,
        previousBoundProjectId: token.boundProjectId,
        projectIds: input.fence.projectIds,
        boundProjectId: input.fence.boundProjectId,
        reason: input.reason,
      })
      .returning();
    if (!change) throw new Error('setPatFence: the audit insert returned no row');

    return { ok: true, token: updated, change: fenceChangeView(change) };
  });
}

export async function listPatFenceChanges(
  tokenId: string,
  ownerId: string,
  limit: number,
): Promise<PatFenceChangeView[] | null> {
  const owned = await ownedTokenIn(db, tokenId, ownerId);
  if (!owned) return null;
  const rows = await db
    .select()
    .from(patFenceChanges)
    .where(eq(patFenceChanges.tokenId, tokenId))
    .orderBy(desc(patFenceChanges.changedAt))
    .limit(limit);
  return rows.map(fenceChangeView);
}
