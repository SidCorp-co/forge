/**
 * Who may act (S0 agency), decided once. `actMiss` reads an actor against a declared rule; every
 * person-only act (a requirement sign-off, deciding a suggestion), every approval a project's policy
 * assigns (a workflow design, a contract version) and every write only the project's own agent makes
 * (a workflow, an ecosystem link) reads it, and words the refusal under the code its slice names.
 * `personActRefusal` is the person-only case, worded once.
 */

import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole, orgRoleAtLeast, projectRoleAtLeast } from './authz.js';

/**
 * `person`: whether a person may act, and with what standing (member or above on the project, or an
 * owner or admin of its org). `agent`: whether an agent may act; one that may still holds member or
 * above on the project, which is what keeps another project's agent out.
 */
export interface ActRule {
  person: 'never' | 'member' | 'org-admin';
  agent: 'never' | 'member';
}

/** A sign-off or decision only a person of the project gives; an agent drafts and proposes. */
export const PERSON_ACT: ActRule = { person: 'member', agent: 'never' };

/** A write only the project's own agent makes: never a person, never another project's agent. */
export const PROJECT_AGENT_WRITE: ActRule = { person: 'never', agent: 'member' };

/** An approval the project's policy assigns: an org admin person always; the project's own agent only when `agentMay`. */
export const approverRule = (agentMay: boolean): ActRule => ({
  person: 'org-admin',
  agent: agentMay ? 'member' : 'never',
});

export interface ActorFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  /** Read only by a rule whose `person` is `org-admin`. */
  orgRole?: OrgMemberRole | null;
}

/** Why the actor is refused; the slice turns it into its own code and sentence. */
export type ActMiss =
  | { kind: 'person-not-allowed' }
  | { kind: 'agent-not-allowed' }
  | { kind: 'person-below-member' }
  | { kind: 'person-below-org-admin' }
  | { kind: 'agent-below-member' };

// cm:guard the one decision of who may act, so "an agent never signs off" and "another project's agent never writes" cannot drift apart between slices
export function actMiss(facts: ActorFacts, rule: ActRule): ActMiss | null {
  if (facts.agency === 'agent') {
    if (rule.agent === 'never') return { kind: 'agent-not-allowed' };
    return projectRoleAtLeast(facts.role, 'member') ? null : { kind: 'agent-below-member' };
  }
  if (rule.person === 'never') return { kind: 'person-not-allowed' };
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
