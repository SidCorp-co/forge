/**
 * Who is at the keyboard, as the lifecycle gates need to ask it.
 *
 * `actor.type` answers a different question — WHO OWNS the write, which is what
 * `issue_activity.actor_type` and `kernel_transitions.actor_type` store. A job
 * runs under `jobs.created_by`, so its writes really are that person's and
 * should read as theirs. But the caller is an agent, and the ISS-786/812 gates
 * exist to ask exactly that. One enum cannot answer both without lying about
 * one of them.
 */

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
