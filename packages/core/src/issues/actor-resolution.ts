import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, users } from '../db/schema.js';
import { type ActorRef, type ActorType, actorKey, type ResolvedActor } from './actor-identity.js';

// cm:guard ONE resolver for both surfaces, and that is the whole reason it exists rather than a convenience. `comments` and `activity_log` each store an actor as a `(type, id)` pair — `user` pointing at `users.id`, `device` at `devices.id` — and each used to render it on its own: the activity API returned the bare type plus the raw UUID, the comment UI a truncated one. Two renderers of one pair is how the same principal reads as two different people on two screens (ISS-519). Batch-resolve here; never fall back to printing an id at a call site.

const UNKNOWN_LABEL = 'Unknown';

// cm:guard `isAgent` here is the PRINCIPAL-derived FLOOR: what this actor IS, never what one row records. Two columns are in play and only one of them belongs here. `users.kind` is a property of the principal, which is exactly the key this resolver's map is built on, so an agent ACCOUNT reads as an agent on every row it ever wrote (ISS-1093) — without it a `users.kind:'agent'` row rendered as an ordinary person wherever the caller had no per-row column to consult. `activity_log.actor_agency` is the other one and it stays OUT: it varies row by row for one id, so folding it in here would let the last row of a batch decide the marker for all of them; its read is `issues/activity-routes.ts:isAgentForRow`, which ORs it over this floor. The floor can only ever ADD agents, never remove one, which is what the owner's 2026-09-02 deferral was protecting. The writing rules are on `pipeline/activity.ts`.
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
  const agentUserIds = new Set<string>();
  if (userIds.size > 0) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        kind: users.kind,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const r of rows) {
      userEmailById.set(r.id, r.displayName ?? r.email);
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

  // Resolve device owner emails in one extra batched query (owners not already
  // covered by the user lookup above).
  const ownerIdsToFetch = new Set<string>();
  for (const d of deviceById.values()) {
    if (!userEmailById.has(d.ownerId)) ownerIdsToFetch.add(d.ownerId);
  }
  if (ownerIdsToFetch.size > 0) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        kind: users.kind,
      })
      .from(users)
      .where(inArray(users.id, [...ownerIdsToFetch]));
    // cm:why the same `kind` fold as the first query and not a shortcut: these ids are fetched as
    // device OWNERS, but one batch can name the same principal both ways, and a set that is agent
    // on one path and not the other is the two-readers split this resolver exists to prevent.
    for (const r of rows) if (r.kind === 'agent') agentUserIds.add(r.id);
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
          ? { type: 'user', id: ref.id, displayName: email, isAgent: agentUserIds.has(ref.id) }
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
