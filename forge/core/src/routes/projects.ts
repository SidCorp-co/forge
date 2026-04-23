import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assertUserIsProjectMember } from '../auth/policy.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { type UserVars, requireUser } from '../middleware/require-user.js';

export const projectRoutes = new Hono<{ Variables: UserVars }>();

projectRoutes.use('*', requireUser());

projectRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  await assertUserIsProjectMember(c, id);
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      ownerId: projects.ownerId,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!row)
    throw new HTTPException(404, {
      message: 'project not found',
      cause: { code: 'NOT_FOUND' },
    });
  return c.json(row);
});
