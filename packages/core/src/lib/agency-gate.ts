/**
 * S0 agency, decided once: who may perform an act, by whether they act as a person or an agent and
 * what role they hold. Each domain declares its rule and words the refusal under its own code; the
 * decision itself is never re-implemented (docs/conventions/domain-entities.md "Who may act").
 */

import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { orgRoleAtLeast, projectRoleAtLeast } from './authz.js';

export interface ActorFacts {
  userId: string;
  agency: ActorAgency;
  /** The actor's effective role on the project the act is on, through the token's fence. */
  role: ProjectMemberRole | null;
  /** The actor's role in that project's organization; read only by a rule naming `org-admin`. */
  orgRole?: OrgMemberRole | null;
}

/**
 * `person`: whether a person may act, and with what standing (project member or above, or an org
 * owner or admin). `agent`: whether an agent may act; one that may must hold member or above on the
 * project, which is what keeps another project's agent out.
 */
export interface AgencyRule {
  person: 'never' | 'member' | 'org-admin';
  agent: 'never' | 'member';
}

/** Why an actor is refused; the domain turns it into its own code and sentence. */
export type AgencyMiss =
  | { kind: 'person-not-allowed' }
  | { kind: 'agent-not-allowed' }
  | { kind: 'person-below-member'; role: ProjectMemberRole | null }
  | { kind: 'person-below-org-admin'; orgRole: OrgMemberRole | null }
  | { kind: 'agent-below-member'; role: ProjectMemberRole | null };

// cm:guard the one decision of who may act: every person-only sign-off and every agent-only write
// reads it, so "an agent never signs" and "another project's agent never writes" cannot drift apart
export function agencyMiss(facts: ActorFacts, rule: AgencyRule): AgencyMiss | null {
  if (facts.agency === 'agent') {
    if (rule.agent === 'never') return { kind: 'agent-not-allowed' };
    return projectRoleAtLeast(facts.role, 'member')
      ? null
      : { kind: 'agent-below-member', role: facts.role };
  }
  if (rule.person === 'never') return { kind: 'person-not-allowed' };
  if (rule.person === 'org-admin') {
    const orgRole = facts.orgRole ?? null;
    return orgRoleAtLeast(orgRole, 'admin') ? null : { kind: 'person-below-org-admin', orgRole };
  }
  return projectRoleAtLeast(facts.role, 'member')
    ? null
    : { kind: 'person-below-member', role: facts.role };
}

/** A sign-off only a person of the project gives: an agent drafts and proposes, never signs. */
export const PERSON_SIGNOFF: AgencyRule = { person: 'member', agent: 'never' };

/** A write only the project's own agent makes: no person, and no other project's agent. */
export const PROJECT_AGENT_WRITE: AgencyRule = { person: 'never', agent: 'member' };

/** An approval the project's policy assigns: an org admin person always, the project's master when the policy says `master`. */
export const approverRule = (agentMay: boolean): AgencyRule => ({
  person: 'org-admin',
  agent: agentMay ? 'member' : 'never',
});
