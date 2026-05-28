import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { type ProjectMemberRole, projectMembers, projects } from '../db/schema.js';

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export type ProjectAccess = {
  projectId: string;
  ownerId: string;
  role: ProjectMemberRole | null;
};

export async function loadProjectAccess(
  projectId: string,
  userId: string,
  notFoundMessage = 'project not found',
): Promise<ProjectAccess> {
  const [project] = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound(notFoundMessage);

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { projectId: project.id, ownerId: project.ownerId, role: member?.role ?? null };
}

export function assertMember(access: ProjectAccess): void {
  if (!access.role) throw forbidden('not a project member');
}

export function assertOwner(access: ProjectAccess, userId: string): void {
  if (access.ownerId !== userId && access.role !== 'owner') {
    throw forbidden('not a project owner');
  }
}

/**
 * One-shot membership check that does NOT leak existence: any failure mode
 * (project missing, user not a member) throws the same 403. Use this for
 * surfaces where exposing project IDs would be a security leak — e.g. memory
 * routes, where a 404 vs 403 distinction would let callers probe project IDs.
 */
export async function assertProjectMemberAccess(
  projectId: string,
  userId: string,
): Promise<void> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw forbidden('not a project member');
  if (project.ownerId === userId) return;

  const [member] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!member) throw forbidden('not a project member');
}
