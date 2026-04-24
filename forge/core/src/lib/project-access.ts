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
