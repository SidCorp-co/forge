/**
 * The actor vocabulary shared by the comments and activity surfaces: what an
 * actor ref is, what it resolves to, and how it is keyed in a lookup map.
 *
 * A leaf on purpose — `actor-resolution.ts` does the reads and therefore drags
 * in the Postgres client, which nothing that only needs to FORMAT a key should
 * have to import. Splitting these out is what lets `comments/tree.ts` stay a
 * pure module with a plain unit test.
 */

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
  /** True when an agent performed the action, false for a person at a keyboard. */
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
