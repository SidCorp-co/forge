// What the person's role must hold for a held write to be offered as a card (REQ-30 BC-4): the same
// right the write's own route or tool asks, so a write the role could not make is refused for the
// permission it lacks, never shown as a card that would only fail when pressed. One table for both
// doors: the Assistant's turn gate and the REST hold.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { loadProjectAccess } from '../../lib/authz.js';
import {
  actorFor,
  type ProjectPermission,
  projectResource,
  requireCan,
  requireOrgHeld,
} from '../../permissions/index.js';

/** A project permission, or the org owner's or admin's right a project's own settings ask. */
type RoleNeed = { project: ProjectPermission } | { org: 'org.admin' } | null;

const WRITE: RoleNeed = { project: 'project.write' };

/** By kind. Preferences are the person's own, which every role changes. */
export const ROLE_NEEDED: Record<ChatProposalKind, RoleNeed> = {
  feedback: WRITE,
  requirement_draft: WRITE,
  requirement_revision: WRITE,
  requirement_link: WRITE,
  comment: WRITE,
  attachment: WRITE,
  memory_note: WRITE,
  preferences: null,
  report_save: WRITE,
  issue_change: WRITE,
  // `projects/routes.ts`: a project's settings, archive and unarchive need the org's admin
  project_change: { org: 'org.admin' },
};

/** Throws the refusal naming the right `userId` lacks for a `kind` write in `projectId`. */
export async function requireRoleFor(
  kind: ChatProposalKind,
  userId: string,
  projectId: string,
): Promise<void> {
  const need = ROLE_NEEDED[kind];
  if (!need) return;
  if ('project' in need) {
    await requireCan(actorFor(userId), need.project, projectResource(projectId));
    return;
  }
  const access = await loadProjectAccess(projectId, userId);
  requireOrgHeld(access.orgId, access.orgRole, need.org);
}
