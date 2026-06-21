import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';

// ISS-519 — shared actor resolution. Comments and activity_log both store an
// actor as a `(type, id)` pair where type is 'user' (a human, id → users.id) or
// 'device' (an agent/runner, id → devices.id). Neither surface used to resolve
// that id to a human-readable identity: the activity API returned the bare
// actorType + raw UUID and the comment UI fell back to a truncated UUID. This
// helper batch-resolves any set of actor refs to a display identity so both
// surfaces (and any future caller) share one source of truth.

export type ActorType = 'user' | 'device';

export interface ActorRef {
  type: ActorType;
  id: string;
}

export interface ResolvedActor {
  type: ActorType;
  id: string;
  /** Human-readable label: user → email; device → device name. */
  displayName: string;
  /** True for a device principal (an agent action), false for a human user. */
  isAgent: boolean;
  /** The device id when type==='device' (mirrors `id`); omitted for users. */
  deviceId?: string;
  /** Owning member's email for a device, when the owner resolves. */
  ownerEmail?: string;
}

/** Stable map key for an actor ref. */
export function actorKey(type: ActorType, id: string): string {
  return `${type}:${id}`;
}

const UNKNOWN_LABEL = 'Unknown';

function unknownActor(type: ActorType, id: string): ResolvedActor {
  return {
    type,
    id,
    displayName: UNKNOWN_LABEL,
    isAgent: type === 'device',
    ...(type === 'device' ? { deviceId: id } : {}),
  };
}

/**
 * Batch-resolve a set of actor refs to display identities, keyed by
 * `actorKey(type, id)`. Users resolve to their email; devices resolve to the
 * device name plus (best-effort) the owning member's email. An id that matches
 * no row degrades to a defined `Unknown` fallback — never throws — so a stale
 * actorId on an old row can't 500 the comments/activity endpoints.
 */
export async function resolveActors(refs: ActorRef[]): Promise<Map<string, ResolvedActor>> {
  const result = new Map<string, ResolvedActor>();
  if (refs.length === 0) return result;

  // Dedupe ids per type so each `inArray` query stays bounded (mirrors the
  // bounded-set pattern in comments/mentions.ts).
  const userIds = new Set<string>();
  const deviceIds = new Set<string>();
  for (const ref of refs) {
    if (ref.type === 'user') userIds.add(ref.id);
    else if (ref.type === 'device') deviceIds.add(ref.id);
  }

  const userEmailById = new Map<string, string>();
  if (userIds.size > 0) {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const r of rows) userEmailById.set(r.id, r.email);
  }

  const deviceById = new Map<string, { name: string; ownerId: string }>();
  if (deviceIds.size > 0) {
    const rows = await db
      .select({ id: devices.id, name: devices.name, ownerId: devices.ownerId })
      .from(devices)
      .where(inArray(devices.id, [...deviceIds]));
    for (const r of rows) deviceById.set(r.id, { name: r.name, ownerId: r.ownerId });
  }

  // Resolve device owner emails in one extra batched query (owners not already
  // covered by the user lookup above).
  const ownerIdsToFetch = new Set<string>();
  for (const d of deviceById.values()) {
    if (!userEmailById.has(d.ownerId)) ownerIdsToFetch.add(d.ownerId);
  }
  if (ownerIdsToFetch.size > 0) {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, [...ownerIdsToFetch]));
    for (const r of rows) userEmailById.set(r.id, r.email);
  }

  for (const ref of refs) {
    const key = actorKey(ref.type, ref.id);
    if (result.has(key)) continue;
    if (ref.type === 'user') {
      const email = userEmailById.get(ref.id);
      result.set(
        key,
        email
          ? { type: 'user', id: ref.id, displayName: email, isAgent: false }
          : unknownActor('user', ref.id),
      );
    } else {
      const device = deviceById.get(ref.id);
      if (!device) {
        result.set(key, unknownActor('device', ref.id));
        continue;
      }
      const ownerEmail = userEmailById.get(device.ownerId);
      result.set(key, {
        type: 'device',
        id: ref.id,
        displayName: device.name,
        isAgent: true,
        deviceId: ref.id,
        ...(ownerEmail ? { ownerEmail } : {}),
      });
    }
  }

  return result;
}
