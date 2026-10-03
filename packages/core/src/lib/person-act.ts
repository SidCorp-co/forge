/**
 * Who may act (S0 agency), decided once by `actMiss` against a declared rule; each slice words the
 * refusal under its own code.
 */

import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole, orgRoleAtLeast, projectRoleAtLeast } from './authz.js';

/** An agent that may act still holds member or above, which keeps another project's agent out. */
export interface ActRule {
  person: 'never' | 'member' | 'project-admin' | 'org-admin';
  agent: 'never' | 'member';
}

/** A sign-off or decision only a person of the project gives; an agent drafts and proposes. */
export const PERSON_ACT: ActRule = { person: 'member', agent: 'never' };

/** A write only the project's own agent makes: never a person, never another project's agent. */
export const PROJECT_AGENT_WRITE: ActRule = { person: 'never', agent: 'member' };

/** An act on reporter data only a project admin person takes (UC15): never an agent. */
export const PERSON_ADMIN_ACT: ActRule = { person: 'project-admin', agent: 'never' };

/** An approval the project's policy assigns: an org admin person always; the project's own agent only when `agentMay`. */
export const approverRule = (agentMay: boolean): ActRule => ({
  person: 'org-admin',
  agent: agentMay ? 'member' : 'never',
});

export interface ActorFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  orgRole?: OrgMemberRole | null;
}

export type ActMiss =
  | { kind: 'person-not-allowed' }
  | { kind: 'agent-not-allowed' }
  | { kind: 'person-below-member' }
  | { kind: 'person-below-project-admin' }
  | { kind: 'person-below-org-admin' }
  | { kind: 'agent-below-member' };

// cm:guard the one decision of who may act, so "an agent never signs off" and "another project's agent never writes" cannot drift apart between slices
export function actMiss(facts: ActorFacts, rule: ActRule): ActMiss | null {
  if (facts.agency === 'agent') {
    if (rule.agent === 'never') return { kind: 'agent-not-allowed' };
    return projectRoleAtLeast(facts.role, 'member') ? null : { kind: 'agent-below-member' };
  }
  if (rule.person === 'never') return { kind: 'person-not-allowed' };
  if (rule.person === 'project-admin') {
    return projectRoleAtLeast(facts.role, 'admin') ? null : { kind: 'person-below-project-admin' };
  }
  if (rule.person === 'org-admin') {
    return orgRoleAtLeast(facts.orgRole ?? null, 'admin')
      ? null
      : { kind: 'person-below-org-admin' };
  }
  return projectRoleAtLeast(facts.role, 'member') ? null : { kind: 'person-below-member' };
}

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
  const miss = actMiss(facts, PERSON_ACT);
  if (!miss) return null;
  return {
    code,
    path: '',
    detail:
      miss.kind === 'agent-not-allowed'
        ? `${facts.userId} acts as an agent; ${act} is a person's act on this project. An agent or the assistant drafts and proposes, and leaves it to them.`
        : `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; ${act} is a person's act of this project (member or above).`,
  };
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
