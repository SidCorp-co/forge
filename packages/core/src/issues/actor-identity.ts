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
  /** Owning member's email for a device, when the owner resolves. */
  ownerEmail?: string;
}

/** Stable map key for an actor ref. */
export function actorKey(type: ActorType, id: string): string {
  return `${type}:${id}`;
}
