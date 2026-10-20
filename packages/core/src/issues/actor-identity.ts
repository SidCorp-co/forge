export type ActorType = 'user' | 'device';

export interface ActorRef {
  type: ActorType;
  id: string;
}

export interface ResolvedActor {
  type: ActorType;
  id: string;
  displayName: string;
  isAgent: boolean;
  deviceId?: string;
  /** What the device's owning member is called, when the owner resolves (ISS-1229: never their address). */
  ownerName?: string;
  ownerId?: string;
}

/** Stable map key for an actor ref. */
export function actorKey(type: ActorType, id: string): string {
  return `${type}:${id}`;
}
