/**
 * Who may act (S0 agency) on the writes that are not approvals, decided once by `actMiss` against a
 * declared rule; each slice words the refusal under its own code. An approval never comes here: it is
 * a permission (`lib/approval.ts`, ADR 0007).
 */

import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { orgRoleAtLeast, projectRoleAtLeast } from './authz.js';

/** An agent that may act still holds member or above, which keeps another project's agent out. */
export interface ActRule {
  person: 'never' | 'member' | 'project-admin' | 'org-admin';
  agent: 'never' | 'member';
}

/** An act only a person of the project takes (answering a questionnaire, asking for onboarding). */
export const PERSON_ACT: ActRule = { person: 'member', agent: 'never' };

/** A write only the project's own agent makes: never a person, never another project's agent. */
export const PROJECT_AGENT_WRITE: ActRule = { person: 'never', agent: 'member' };

export const PROJECT_MEMBER_WRITE: ActRule = { person: 'member', agent: 'member' };

/** An act on reporter data only a project admin person takes (UC15): never an agent. */
export const PERSON_ADMIN_ACT: ActRule = { person: 'project-admin', agent: 'never' };

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

// cm:guard the one decision of who may act, so "another project's agent never writes" cannot drift apart between slices
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
