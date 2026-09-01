/**
 * Pinning a project skill — the intentional, permanent divergence marker
 * (ISS-795 §10, invariant 10). Split out of `service.ts` when the MCP tool
 * went away (ISS-894 wave 3): the only caller is now `pin-routes.ts`.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { skills } from '../db/schema.js';
import { recordSkillActivityEvent } from './activity.js';
import { type SkillRow, skillProjection } from './service.js';

export interface SetSkillPinnedInput {
  projectId: string;
  skillId: string;
  pinned: boolean;
  /** Required when pinning; ignored when unpinning. */
  reason?: string | undefined;
  actorUserId: string;
}

/**
 * Mark (or clear) a project skill as `pinned` — intentional, permanent
 * divergence from its template that must never surface as `behindTemplate`
 * or drift-sweep noise (ISS-795 §10 / invariant 10). Writes the column and the
 * `skill.pinned` activity event in the SAME transaction (§9.11).
 */
export async function setSkillPinned(input: SetSkillPinnedInput): Promise<SkillRow> {
  if (input.pinned && !input.reason?.trim()) {
    throw new Error('BAD_REQUEST: reason is required to pin a skill');
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = (await tx
      .update(skills)
      .set({
        pinned: input.pinned,
        pinnedReason: input.pinned ? (input.reason?.trim() ?? null) : null,
        pinnedBy: input.pinned ? input.actorUserId : null,
        pinnedAt: input.pinned ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, input.skillId), eq(skills.projectId, input.projectId)))
      .returning(skillProjection)) as SkillRow[];
    if (!row) throw new Error('NOT_FOUND: skill not found');

    const reason = input.pinned ? (input.reason?.trim() ?? '') : 'unpinned';
    await recordSkillActivityEvent(tx, {
      eventType: 'skill.pinned',
      actor: `human:${input.actorUserId}`,
      trigger: 'manual',
      projectId: input.projectId,
      skillId: input.skillId,
      reason,
      outcome: 'ok',
    });
    return row;
  });
  return updated;
}
