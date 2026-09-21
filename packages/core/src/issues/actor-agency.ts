export type ActorAgency = 'human' | 'agent';

/** The agency an audit row records. A user carries its own, from `users.kind`. */
export function actorAgency(actor: {
  type: 'user' | 'device';
  agency?: ActorAgency | undefined;
}): ActorAgency {
  if (actor.type === 'device') return 'agent';
  return actor.agency ?? 'human';
}

export type DeviceLite = { id: string; ownerId: string };

export type TransitionActor =
  | { type: 'user'; id: string; agency?: ActorAgency | undefined }
  | ({ type: 'device' } & DeviceLite);
