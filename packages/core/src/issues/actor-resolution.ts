import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import { personName } from '../lib/person-name.js';
import { type ActorRef, type ActorType, actorKey, type ResolvedActor } from './actor-identity.js';

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
 * `actorKey(type, id)`. Users resolve to what `personName` calls them; devices resolve to the
 * device name plus (best-effort) what the owning member is called. An id that matches
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

  const displayNameById = new Map<string, string | null>();
  const agentUserIds = new Set<string>();
  if (userIds.size > 0) {
    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        kind: users.kind,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const r of rows) {
      displayNameById.set(r.id, r.displayName);
      if (r.kind === 'agent') agentUserIds.add(r.id);
    }
  }

  const deviceById = new Map<string, { name: string; ownerId: string }>();
  if (deviceIds.size > 0) {
    const rows = await db
      .select({ id: devices.id, name: devices.name, ownerId: devices.ownerId })
      .from(devices)
      .where(inArray(devices.id, [...deviceIds]));
    for (const r of rows) deviceById.set(r.id, { name: r.name, ownerId: r.ownerId });
  }

  // Resolve device owners in one extra batched query (owners not already
  // covered by the user lookup above).
  const ownerIdsToFetch = new Set<string>();
  for (const d of deviceById.values()) {
    if (!displayNameById.has(d.ownerId)) ownerIdsToFetch.add(d.ownerId);
  }
  if (ownerIdsToFetch.size > 0) {
    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        kind: users.kind,
      })
      .from(users)
      .where(inArray(users.id, [...ownerIdsToFetch]));
    for (const r of rows) if (r.kind === 'agent') agentUserIds.add(r.id);
    for (const r of rows) displayNameById.set(r.id, r.displayName);
  }

  for (const ref of refs) {
    const key = actorKey(ref.type, ref.id);
    if (result.has(key)) continue;
    if (ref.type === 'user') {
      result.set(
        key,
        displayNameById.has(ref.id)
          ? {
              type: 'user',
              id: ref.id,
              displayName: personName(displayNameById.get(ref.id), 'start'),
              isAgent: agentUserIds.has(ref.id),
            }
          : unknownActor('user', ref.id),
      );
    } else {
      const device = deviceById.get(ref.id);
      if (!device) {
        result.set(key, unknownActor('device', ref.id));
        continue;
      }
      const ownerName = displayNameById.has(device.ownerId)
        ? personName(displayNameById.get(device.ownerId))
        : undefined;
      result.set(key, {
        type: 'device',
        id: ref.id,
        displayName: device.name,
        isAgent: true,
        deviceId: ref.id,
        ...(ownerName ? { ownerName, ownerId: device.ownerId } : {}),
      });
    }
  }

  return result;
}

/**
 * What each user is called; an id with no user row is absent, never "Unknown". `at` is where the
 * name stands: 'start' opens a label or a sentence, 'inside' sits mid-sentence ("a member").
 */
export async function userLabels(
  ids: string[],
  at: 'inside' | 'start' = 'start',
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) labels.set(row.id, personName(row.displayName, at));
  return labels;
}
