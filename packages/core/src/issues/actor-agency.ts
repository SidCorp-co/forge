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

// cm:guard a `device` actor is ALWAYS an agent and cannot be overridden — the field is optional so that every existing caller keeps its exact behaviour (no `agency` on a `user` actor reads `human`, which is what `actorType !== 'device'` meant), and the only writer of `agency: 'agent'` is a surface that authenticated an agent-held credential. Defaulting the other way would open every gate the day a caller forgot the field, which is the failure mode this whole axis was introduced to close.
export function actorAgency(actor: { type: 'user' | 'device'; agency?: ActorAgency }): ActorAgency {
  return actor.type === 'device' ? 'agent' : (actor.agency ?? 'human');
}

export type DeviceLite = { id: string; ownerId: string };

// cm:guard `agency` MUST NOT reach the `actor_type` columns — it answers whether the caller is a person, while `type` answers who owns the write, and a job or session token makes the two differ (the write is its creator's, the caller is an agent). It is now STORED, but in its own column beside `actor_type` and never folded into it: `activity_log.actor_agency` (migration 0193) and `kernel_transitions.actor_agency` (ISS-927). Every gate that asks at call time still reads it through `actorAgency` — persistence is a record of what was decided, not a second place to decide it.
export type TransitionActor =
  | { type: 'user'; id: string; agency?: ActorAgency }
  | ({ type: 'device' } & DeviceLite);
