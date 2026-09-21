/**
 * An agent's self — read and written by org admins through the agents surface,
 * rendered by every door that speaks as the handle (ISS-1034).
 *
 * The self RENDERS and decides nothing: no key, no address, no authority reads
 * it. Its one structured part, `presence`, is validated by
 * `conversations/presence.ts`, the module that reads it.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validatePresence } from '../conversations/presence.js';
import { db as defaultDb } from '../db/client.js';
import { agentSelves, type PresenceConfig } from '../db/schema-agent-selves.js';
import { loadOrgAgent } from './agent-accounts.js';

export interface AgentSelf {
  userId: string;
  soul: string | null;
  instructions: string | null;
  emoji: string | null;
  greeting: string | null;
  presence: PresenceConfig;
  updatedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

const selection = {
  userId: agentSelves.userId,
  soul: agentSelves.soul,
  instructions: agentSelves.instructions,
  emoji: agentSelves.emoji,
  greeting: agentSelves.greeting,
  presence: agentSelves.presence,
  updatedBy: agentSelves.updatedBy,
  createdAt: agentSelves.createdAt,
  updatedAt: agentSelves.updatedAt,
};

export const agentSelfPatchSchema = z
  .object({
    soul: z.string().trim().max(8000).nullable().optional(),
    instructions: z.string().trim().max(8000).nullable().optional(),
    emoji: z.string().trim().max(16).nullable().optional(),
    greeting: z.string().trim().max(500).nullable().optional(),
    presence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    error: 'a self PATCH must carry at least one of soul, instructions, emoji, greeting, presence',
  });
export type AgentSelfPatch = z.infer<typeof agentSelfPatchSchema>;

/** What a handle with no row reads as: nothing set, today's presence. */
export function emptySelf(userId: string): AgentSelf {
  return {
    userId,
    soul: null,
    instructions: null,
    emoji: null,
    greeting: null,
    presence: {},
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * The self of an agent in this org; `undefined` when the id is not one of the
 * org's agents, `emptySelf` when it is one and has written nothing yet.
 */
export async function readAgentSelf(
  orgId: string,
  agentUserId: string,
): Promise<AgentSelf | undefined> {
  if (!(await loadOrgAgent(orgId, agentUserId))) return undefined;
  const [row] = await defaultDb
    .select(selection)
    .from(agentSelves)
    .where(eq(agentSelves.userId, agentUserId))
    .limit(1);
  return row ?? emptySelf(agentUserId);
}

/**
 * Write part of a self. Text fields are set to what the patch says (null
 * clears one). `presence` is MERGED key by key onto what is stored, a key sent
 * as `null` is removed, and the merged whole is validated.
 */
export async function writeAgentSelf(
  orgId: string,
  agentUserId: string,
  patch: AgentSelfPatch,
  updatedBy: string,
): Promise<AgentSelf | undefined> {
  const current = await readAgentSelf(orgId, agentUserId);
  if (!current) return undefined;

  let presence: PresenceConfig | undefined;
  if (patch.presence !== undefined) {
    const merged: Record<string, unknown> = { ...current.presence };
    for (const [key, value] of Object.entries(patch.presence)) {
      if (key === 'heartbeat' && value !== null && typeof value === 'object') {
        const hb: Record<string, unknown> = {
          ...((merged.heartbeat as Record<string, unknown> | undefined) ?? {}),
        };
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (v === null) delete hb[k];
          else hb[k] = v;
        }
        if (Object.keys(hb).length === 0) delete merged.heartbeat;
        else merged.heartbeat = hb;
        continue;
      }
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    presence = validatePresence(merged);
  }

  const set = {
    ...(patch.soul !== undefined ? { soul: patch.soul } : {}),
    ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
    ...(patch.greeting !== undefined ? { greeting: patch.greeting } : {}),
    ...(presence !== undefined ? { presence } : {}),
    updatedBy,
  };
  const [row] = await defaultDb
    .insert(agentSelves)
    .values({ userId: agentUserId, ...set })
    .onConflictDoUpdate({
      target: agentSelves.userId,
      set: { ...set, updatedAt: sql`now()` },
    })
    .returning(selection);
  if (!row) throw new Error('agent_selves: upsert returned no row');
  return row;
}

/**
 * The selves of several handles at once, for a room's persona and presence;
 * a handle with no row is absent from the map and reads as `emptySelf`.
 */
export async function readSelvesFor(
  userIds: readonly string[],
  tx: Pick<typeof defaultDb, 'select'> = defaultDb,
): Promise<Map<string, AgentSelf>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx
    .select(selection)
    .from(agentSelves)
    .where(inArray(agentSelves.userId, [...userIds]));
  return new Map(rows.map((r) => [r.userId, r]));
}
