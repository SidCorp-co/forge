export type ActorAgency = 'human' | 'agent';

/**
 * The agency an audit row records for an actor (ISS-1137).
 *
 * A device is a machine. A user actor carries its own answer, which the
 * credential doors take from `users.kind` and never from the door's name. An
 * actor with no agency at all is one with no credential behind it — a sweeper,
 * a release batch, a recovery pass — and those are the audit callers
 * `activity_log.actor_agency` and `kernel_transitions.actor_agency` exist for.
 *
 * What is NOT here any more is the line that read an explicit `null` as
 * 'agent'. That was an over-approximation from before agents had accounts of
 * their own, and it outlived its premise: it turned every person filing on
 * their own token into an agent, because the door handed it a `null` it had
 * itself thrown a known `users.kind` away to produce.
 */
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
