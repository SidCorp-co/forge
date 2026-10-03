/**
 * The approval gate on a contract version: recorded as proposed, current only once approved.
 *
 * Whether a person or the project's own agent may decide is the project's policy
 * (`contracts.approver`), with one rule no policy loosens: a version measured breaking, or one no
 * differ could measure, is decided by a person, because the consumers it may break are not the
 * agent's to break.
 */

import type { OrgMemberRole, ProjectMemberRole } from '../../db/schema.js';
import type { ActorAgency } from '../../issues/actor-agency.js';
import { orgRoleAtLeast, projectRoleAtLeast } from '../../lib/authz.js';
import type { DesignApprover } from '../../project-config/schema.js';

export const CONTRACT_APPROVALS = ['proposed', 'approved', 'returned'] as const;
export type ContractApproval = (typeof CONTRACT_APPROVALS)[number];

export const CONTRACT_DECISIONS = ['approve', 'return'] as const;
export type ContractDecision = (typeof CONTRACT_DECISIONS)[number];

export const CONTRACT_DECISION_REASON_MAX = 2000;

/** Who decided a version; `before-approval` marks the versions recorded before the gate existed. */
export type DecidedAs = 'person' | 'agent' | 'before-approval';

export type ApprovalRefusalCode =
  | 'CONTRACT_VERSION_NOT_PROPOSED'
  | 'CONTRACT_DECISION_REASON_MISSING'
  | 'CONTRACT_BREAKING_NEEDS_PERSON'
  | 'CONTRACT_APPROVER_NOT_PERSON'
  | 'CONTRACT_APPROVER_NOT_ADMIN'
  | 'CONTRACT_APPROVER_NOT_PROJECT';

export interface ApprovalRefusal {
  code: ApprovalRefusalCode;
  path: string;
  detail: string;
}

export interface ApproverFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  orgRole: OrgMemberRole | null;
}

/** Only a version measured non-breaking, or the first one, is ever the agent's to approve. */
const AGENT_DECIDABLE: ReadonlySet<string> = new Set(['non-breaking', 'initial']);

// cm:guard a breaking or unmeasured version is approved by a person whatever `contracts.approver` says — the one decision an agent never takes for its consumers (ISS-60)
export function approverRefusal(
  facts: ApproverFacts,
  version: { ref: string; classification: string },
  approver: DesignApprover,
  projectId: string,
): ApprovalRefusal | null {
  if (facts.agency !== 'agent') {
    if (orgRoleAtLeast(facts.orgRole, 'admin')) return null;
    return {
      code: 'CONTRACT_APPROVER_NOT_ADMIN',
      path: '',
      detail: `${facts.userId} holds ${facts.orgRole ?? 'no role'} in project ${projectId}'s organization; a person deciding a contract version is an org owner or admin.`,
    };
  }
  if (!AGENT_DECIDABLE.has(version.classification)) {
    return {
      code: 'CONTRACT_BREAKING_NEEDS_PERSON',
      path: '',
      detail: `${version.ref} is measured ${version.classification}; a breaking or unmeasured version is decided by a person (an org owner or admin), whatever contracts.approver says, because the consumers it may break are not an agent's to break.`,
    };
  }
  if (approver === 'owner') {
    return {
      code: 'CONTRACT_APPROVER_NOT_PERSON',
      path: '',
      detail: `agent ${facts.userId} acts as an agent; project ${projectId} declares contracts.approver "owner", so only an org admin person decides its contract versions. The owner sets it to "master" (PUT /api/projects/${projectId}/config) to let the project's master approve non-breaking ones.`,
    };
  }
  if (projectRoleAtLeast(facts.role, 'member')) return null;
  return {
    code: 'CONTRACT_APPROVER_NOT_PROJECT',
    path: '',
    detail: `agent ${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; with contracts.approver "master" a version is decided by that project's own master, never another project's agent.`,
  };
}

export function decisionRefusals(input: {
  ref: string;
  approval: string;
  decision: ContractDecision;
  reason: string | null;
}): ApprovalRefusal[] {
  if (input.approval !== 'proposed') {
    return [
      {
        code: 'CONTRACT_VERSION_NOT_PROPOSED',
        path: '/decision',
        detail: `${input.ref} is ${input.approval}; only a proposed version is approved or returned, and a decided one stays as it was decided. A change is recorded as a new version.`,
      },
    ];
  }
  if (input.decision === 'return' && !input.reason?.trim()) {
    return [
      {
        code: 'CONTRACT_DECISION_REASON_MISSING',
        path: '/reason',
        detail: 'a returned version says why, so whoever proposed it knows what to change.',
      },
    ];
  }
  return [];
}
