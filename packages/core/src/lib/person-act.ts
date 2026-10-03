/**
 * Whether a person of the project is the one acting: the check every person-only act shares — a
 * requirement sign-off (ISS-57), deciding a suggestion (ISS-58). An agent (S0 agency), or a person
 * below member on the project, is refused under the code the calling slice names.
 */

import type { ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole, projectRoleAtLeast } from './authz.js';

export interface PersonActFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
}

export interface PersonActRefusal<C extends string> {
  code: C;
  path: string;
  detail: string;
}

// cm:guard a person's act on a project is a human (S0 agency) holding member or above there; anything
// else is refused under the slice's own code, never let through and never a 403 of its own shape
export function personActRefusal<C extends string>(
  facts: PersonActFacts,
  projectId: string,
  act: string,
  code: C,
): PersonActRefusal<C> | null {
  if (facts.agency !== 'human') {
    return {
      code,
      path: '',
      detail: `${facts.userId} acts as an agent; ${act} is a person's act on this project. An agent or the assistant drafts and proposes, and leaves it to them.`,
    };
  }
  if (!projectRoleAtLeast(facts.role, 'member')) {
    return {
      code,
      path: '',
      detail: `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; ${act} is a person's act of this project (member or above).`,
    };
  }
  return null;
}

/** The same check, reading the actor's role on the project first. */
export async function personActRefusalFor<C extends string>(
  actor: { userId: string; agency: ActorAgency },
  projectId: string,
  act: string,
  code: C,
): Promise<PersonActRefusal<C> | null> {
  const access = await effectiveProjectRole(actor.userId, projectId);
  return personActRefusal({ ...actor, role: access?.role ?? null }, projectId, act, code);
}
