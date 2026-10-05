/**
 * The approval gate on a contract version: recorded as proposed, current only once approved, by
 * whoever holds contracts.approve on the provider project (ADR 0007), a breaking version included.
 */

import type { ContractApprovalRefusalCode } from '@forge/contracts/ecosystem';
import { type PermissionFacts, permissionRefusal } from '../../permissions/index.js';

const CONTRACT_APPROVALS = ['proposed', 'approved', 'returned'] as const;
export type ContractApproval = (typeof CONTRACT_APPROVALS)[number];

export const CONTRACT_DECISIONS = ['approve', 'return'] as const;
export type ContractDecision = (typeof CONTRACT_DECISIONS)[number];

export const CONTRACT_DECISION_REASON_MAX = 2000;

/** Who decided a version; `before-approval` marks the versions recorded before the gate existed. */
export type DecidedAs = 'person' | 'agent' | 'before-approval';

interface ApprovalRefusal {
  code: ContractApprovalRefusalCode;
  path: string;
  detail: string;
}

export function approverRefusal(
  facts: PermissionFacts,
  version: { ref: string },
): ApprovalRefusal | null {
  return permissionRefusal(facts, 'contracts.approve', `deciding ${version.ref}`);
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
