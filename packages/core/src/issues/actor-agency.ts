export type ActorAgency = 'human' | 'agent';

export function actorAgency(actor: {
  type: 'user' | 'device';
  agency?: ActorAgency | null;
}): ActorAgency {
  if (actor.type === 'device') return 'agent';
  if (actor.agency === null) return 'agent';
  return actor.agency ?? 'human';
}

export type DeviceLite = { id: string; ownerId: string };

export type TransitionActor =
  | { type: 'user'; id: string; agency?: ActorAgency | null }
  | ({ type: 'device' } & DeviceLite);
