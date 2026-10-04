/**
 * The one writer of memberships: project and org membership rows, their roles and grants. They
 * are kernel-owned data (`modules.json`: permissions owns `projectMembers` and
 * `organizationMembers`), so the check in `can.ts` reads only its own tables and every module that
 * adds, changes or drops a membership calls these. Who may do so is the caller's `can()`; nothing
 * here decides it.
 */

import type { ProjectPermission } from '@forge/contracts/permissions';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  type OrgMemberRole,
  organizationMembers,
  type ProjectMemberRole,
  projectMembers,
} from '../db/schema.js';

export type ProjectMembershipRow = typeof projectMembers.$inferSelect;
export type OrgMembershipRow = typeof organizationMembers.$inferSelect;

export interface NewProjectMembership {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  grants?: string[];
}

export interface NewOrgMembership {
  orgId: string;
  userId: string;
  role: OrgMemberRole;
  handle?: string;
}

/**
 * Add project memberships. `ifAbsent` leaves an existing membership as it is and answers only the
 * rows written; without it, an existing one is a unique violation the caller sees.
 */
export async function addProjectMembers(
  tx: Tx,
  rows: readonly NewProjectMembership[],
  opts: { ifAbsent?: boolean } = {},
): Promise<ProjectMembershipRow[]> {
  if (rows.length === 0) return [];
  const insert = tx.insert(projectMembers).values([...rows]);
  return opts.ifAbsent
    ? insert
        .onConflictDoNothing({ target: [projectMembers.userId, projectMembers.projectId] })
        .returning()
    : insert.returning();
}

/** Change a project membership's role or replace its grant whole; null when there is none. */
export async function updateProjectMember(
  tx: Tx,
  projectId: string,
  userId: string,
  patch: {
    role?: ProjectMemberRole | undefined;
    grants?: readonly ProjectPermission[] | undefined;
  },
): Promise<ProjectMembershipRow | null> {
  const [row] = await tx
    .update(projectMembers)
    .set({
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.grants !== undefined ? { grants: [...new Set(patch.grants)] } : {}),
    })
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .returning();
  return row ?? null;
}

export async function removeProjectMember(tx: Tx, projectId: string, userId: string) {
  await tx
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
}

/** Drop every project membership `userId` holds. */
export async function removeProjectMembershipsOf(tx: Tx, userId: string) {
  await tx.delete(projectMembers).where(eq(projectMembers.userId, userId));
}

/** Add an org membership; `ifAbsent` as for {@link addProjectMembers}, null when one existed. */
export async function addOrgMember(
  tx: Tx,
  row: NewOrgMembership,
  opts: { ifAbsent?: boolean } = {},
): Promise<OrgMembershipRow | null> {
  const insert = tx.insert(organizationMembers).values(row);
  const [written] = opts.ifAbsent
    ? await insert
        .onConflictDoNothing({ target: [organizationMembers.orgId, organizationMembers.userId] })
        .returning()
    : await insert.returning();
  return written ?? null;
}

/** Change an org membership's role or its lenses; null when there is none. */
export async function updateOrgMember(
  tx: Tx,
  orgId: string,
  userId: string,
  patch: { role?: OrgMemberRole | undefined; lenses?: readonly string[] | undefined },
): Promise<OrgMembershipRow | null> {
  const [row] = await tx
    .update(organizationMembers)
    .set({
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.lenses !== undefined ? { lenses: [...new Set(patch.lenses)] } : {}),
    })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning();
  return row ?? null;
}

export async function removeOrgMember(tx: Tx, orgId: string, userId: string) {
  await tx
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
}
