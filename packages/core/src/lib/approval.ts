/**
 * Approval is a permission (docs/adr/0007-approval-is-a-permission.md): every approve-type act asks
 * this module whether the actor holds `<resource>.approve` on the project, and nothing else. An agent
 * holding it approves; an author holding it approves their own proposal; who acted is recorded by
 * the act itself.
 */

import {
  APPROVAL_GRANTS,
  APPROVAL_ROLES,
  type ApprovalRefusal,
  type ApprovalResource,
  approvalPermission,
} from '@forge/contracts/approval';
import type { ProjectMemberRole } from '../db/schema.js';
import { effectiveProjectRole } from './authz.js';

export type { ApprovalRefusal, ApprovalResource };

/** The actor's effective role on the project, org-derived as every other permission reads it. */
export interface ApproverFacts {
  userId: string;
  role: ProjectMemberRole | null;
}

const rank = (role: ProjectMemberRole | null) =>
  role === null ? -1 : APPROVAL_ROLES.indexOf(role);

export function mayApprove(facts: ApproverFacts, resource: ApprovalResource): boolean {
  return rank(facts.role) >= rank(APPROVAL_GRANTS[approvalPermission(resource)]);
}

export function approvalRefusal(
  facts: ApproverFacts,
  resource: ApprovalResource,
  projectId: string,
  act: string,
): ApprovalRefusal | null {
  if (mayApprove(facts, resource)) return null;
  const permission = approvalPermission(resource);
  return {
    code: 'APPROVE_PERMISSION_REQUIRED',
    path: '',
    detail: `${act} needs ${permission} on project ${projectId}; ${facts.userId} holds ${facts.role ?? 'no role'} there, and ${permission} is held by ${APPROVAL_GRANTS[permission]} or above (an org owner or admin holds admin on every project of the org).`,
    permission,
    resource,
  };
}

export async function approverFactsOf(userId: string, projectId: string): Promise<ApproverFacts> {
  const access = await effectiveProjectRole(userId, projectId);
  return { userId, role: access?.role ?? null };
}

/** The same check, reading the actor's role on the project first. */
export async function approvalRefusalFor(
  actor: { userId: string },
  projectId: string,
  resource: ApprovalResource,
  act: string,
): Promise<ApprovalRefusal | null> {
  return approvalRefusal(await approverFactsOf(actor.userId, projectId), resource, projectId, act);
}

export async function mayApproveOn(
  userId: string,
  projectId: string,
  resource: ApprovalResource,
): Promise<boolean> {
  return mayApprove(await approverFactsOf(userId, projectId), resource);
}
