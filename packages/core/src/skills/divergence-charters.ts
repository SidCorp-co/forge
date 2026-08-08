// Divergence Charter service (Update Pipeline §5, ISS-800).
// Storage + read path for per-project intentional-difference records.
// Item 7 in the Master agent's 12-item bundle (ISS-795 §4).
//
// The public contract type DivergenceCharterEntry lives in
// @forge/contracts/divergence-charters (kept in sync by parity test).

import type { DivergenceCharterEntry } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { divergenceCharters } from '../db/schema.js';
import { recordSkillActivityEvent } from './activity.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A drizzle executor: the base `db` or a transaction handle. */
export type CharterExecutor = Db | Tx;

// cm:edge contract -> packages/contracts/src/divergence-charters.ts — divergenceCharterEntrySchema mirrors this; kept in sync by divergence-charters.test.ts
export const divergenceCharterEntrySchema = z.object({
  id: z.string().min(1),
  skill: z.string().min(1),
  difference: z.string().min(1),
  reason: z.string().min(1),
  incidentRefs: z.array(z.string()),
  revertable: z.boolean(),
});

/** Return the charter for a project, or null when no charter exists. */
export async function getCharterByProject(
  executor: CharterExecutor,
  projectId: string,
): Promise<{
  id: string;
  projectId: string;
  entries: DivergenceCharterEntry[];
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const [row] = await executor
    .select()
    .from(divergenceCharters)
    .where(eq(divergenceCharters.projectId, projectId))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    projectId: row.projectId,
    entries: (row.entries as DivergenceCharterEntry[]) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertCharterInput {
  projectId: string;
  entries: DivergenceCharterEntry[];
  /** `human:<user>` | `agent:master` | `system:seeder` */
  actor: string;
  reason?: string | undefined;
}

/**
 * Create or replace the charter for a project.
 * MUST be called inside a transaction — emits `charter.changed` into
 * `skill_activity_events` in the same transaction (invariant §9.11).
 */
// cm:guard Call ONLY inside a db.transaction (pass `tx`, never bare `db`) — charter.changed must be in the same transaction as the upsert.
export async function upsertCharter(
  tx: Tx,
  input: UpsertCharterInput,
): Promise<{
  id: string;
  projectId: string;
  entries: DivergenceCharterEntry[];
  createdAt: Date;
  updatedAt: Date;
}> {
  const [existing] = await tx
    .select({ id: divergenceCharters.id })
    .from(divergenceCharters)
    .where(eq(divergenceCharters.projectId, input.projectId))
    .limit(1);

  const [row] = await tx
    .insert(divergenceCharters)
    .values({
      projectId: input.projectId,
      entries: input.entries,
    })
    .onConflictDoUpdate({
      target: divergenceCharters.projectId,
      set: {
        entries: input.entries,
        updatedAt: new Date(),
      },
    })
    .returning();

  await recordSkillActivityEvent(tx, {
    eventType: 'charter.changed',
    actor: input.actor,
    trigger: 'manual',
    projectId: input.projectId,
    deltaSummary: existing
      ? `updated ${input.entries.length} entries`
      : `created with ${input.entries.length} entries`,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  const saved = row!;
  return {
    id: saved.id,
    projectId: saved.projectId,
    entries: (saved.entries as DivergenceCharterEntry[]) ?? [],
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}
