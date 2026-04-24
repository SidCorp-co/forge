import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memorySources, projectMembers, projects } from '../db/schema.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { runMemorySearch } from './search-service.js';

const searchBodySchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function assertProjectMember(projectId: string, userId: string): Promise<void> {
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

export const memorySearchRoutes = new Hono<{ Variables: AuthVars }>();
memorySearchRoutes.use('/search', requireAuth(), assertEmailVerified());
memorySearchRoutes.post(
  '/search',
  zValidator('json', searchBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');

    await assertProjectMember(body.projectId, userId);

    try {
      const result = await runMemorySearch({
        projectId: body.projectId,
        query: body.query,
        topK: body.topK,
        sourceFilter: body.sourceFilter,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: EMBEDDING_UNAVAILABLE },
        });
      }
      throw err;
    }
  },
);
