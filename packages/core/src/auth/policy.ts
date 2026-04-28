import { and, eq, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectMembers, projects } from '../db/schema.js';
import type { UserVars } from '../middleware/require-user.js';

type UserCtx = Context<{ Variables: UserVars }>;

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export async function assertUserIsProjectMember(c: UserCtx, projectId: string): Promise<void> {
  const user = c.get('user');
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, user.id), eq(projectMembers.projectId, projectId)))
    .limit(1);
  if (!row) throw forbidden('not a project member');
}

export async function assertUserIsProjectOwner(c: UserCtx, projectId: string): Promise<void> {
  const user = c.get('user');
  const [row] = await db
    .select({ projectId: projects.id })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)),
    )
    .where(
      and(
        eq(projects.id, projectId),
        or(eq(projects.ownerId, user.id), eq(projectMembers.role, 'owner')),
      ),
    )
    .limit(1);
  if (!row) throw forbidden('not a project owner');
}
