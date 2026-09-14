import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import { type ActorRef, type ActorType, actorKey, type ResolvedActor } from './actor-identity.js';

// cm:guard ONE resolver for both surfaces, and that is the whole reason it exists rather than a convenience. `comments` and `activity_log` each store an actor as a `(type, id)` pair — `user` pointing at `users.id`, `device` at `devices.id` — and each used to render it on its own: the activity API returned the bare type plus the raw UUID, the comment UI a truncated one. Two renderers of one pair is how the same principal reads as two different people on two screens (ISS-519). Batch-resolve here; never fall back to printing an id at a call site.

const UNKNOWN_LABEL = 'Unknown';

// cm:guard `isAgent` here is the TYPE-derived FLOOR, and it stays type-derived. The per-row `actor_agency` read lives in `issues/activity-routes.ts:isAgentForRow`, which ORs it over this value — it belongs there and not here because this resolver's map is keyed on `(type, id)` while agency varies row by row for the same person. Never replace this with a column read: on its own the column drops the agent marker across every row written before migration 0193, which is what the owner's 2026-09-02 deferral was protecting. The writing rules are on `pipeline/activity.ts`.
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
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const r of rows) userEmailById.set(r.id, r.displayName ?? r.email);
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
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...ownerIdsToFetch]));
    // cm:guard the label prefers `display_name` and falls back to the address, and the fallback is not a stopgap: `display_name` is null until somebody types one, and an activity row for a user who never did must still say something (ISS-1003). What it must NOT do is decide anything — this map feeds rendering only.
    for (const r of rows) userEmailById.set(r.id, r.displayName ?? r.email);
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
