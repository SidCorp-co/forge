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

// cm:guard THREE states, and `undefined` and `null` are not the same one. A `device` actor is always an agent and cannot be overridden. An ABSENT field keeps every existing caller's exact behaviour — a `user` actor with no `agency` reads `human`, which is what `actorType !== 'device'` meant — so a caller that predates the axis is unchanged. An EXPLICIT `null` is unestablished: a credential a person owns, which cannot say a person is at the keyboard and cannot name an agent either, and it fails CLOSED to `agent` because these gates exist for exactly the population that was reading `human` off a borrowed token (ISS-1003). Collapse the two and you choose between reopening that hole and putting every pre-axis caller behind the evidence gates.
export function actorAgency(actor: {
  type: 'user' | 'device';
  agency?: ActorAgency | null;
}): ActorAgency {
  if (actor.type === 'device') return 'agent';
  if (actor.agency === null) return 'agent';
  return actor.agency ?? 'human';
}

export type DeviceLite = { id: string; ownerId: string };

// cm:guard `agency` MUST NOT reach the `actor_type` columns — it answers whether the caller is a person, while `type` answers who owns the write, and a job or session token makes the two differ (the write is its creator's, the caller is an agent). It is now STORED, but in its own column beside `actor_type` and never folded into it: `activity_log.actor_agency` (migration 0193) and `kernel_transitions.actor_agency` (ISS-927). Every gate that asks at call time still reads it through `actorAgency` — persistence is a record of what was decided, not a second place to decide it.
export type TransitionActor =
  | { type: 'user'; id: string; agency?: ActorAgency | null }
  | ({ type: 'device' } & DeviceLite);
