import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memoryRoles, memorySources, projectMembers, projects } from '../db/schema.js';
import { EMBEDDING_UNAVAILABLE, EmbeddingUnavailableError } from '../embeddings/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { runMemorySearch } from './search-service.js';

// `allowedRoles` is a skill-context narrowing filter, NOT a per-user access
// boundary. Project membership is the authentication boundary (asserted
// below); within a project, all members may read all memories. The role
// hierarchy controls which *skill persona* receives which memories so
// e.g. forge-plan can opt into seeing only ceo/cto/techlead-tagged memory
// without coupling that scoping to user identity.
const searchBodySchema = z.object({
  projectId: z.uuid(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(50).default(10),
  sourceFilter: z.array(z.enum(memorySources)).optional(),
  // Non-empty when present: an explicit empty array is rejected so callers
  // are forced to be unambiguous about "narrow to nothing" vs "no filter".
  allowedRoles: z.array(z.enum(memoryRoles)).min(1).optional(),
  // Skill identifier for falling back to a default role scope from
  // SKILL_MEMORY_ROLES when `allowedRoles` is not provided.
  skill: z.string().min(1).max(100).optional(),
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

    let result: Awaited<ReturnType<typeof runMemorySearch>>;
    try {
      result = await runMemorySearch({
        projectId: body.projectId,
        query: body.query,
        topK: body.topK,
        sourceFilter: body.sourceFilter,
        allowedRoles: body.allowedRoles,
        skill: body.skill,
      });
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        throw new HTTPException(503, {
          message: 'embeddings service unavailable',
          cause: { code: EMBEDDING_UNAVAILABLE },
        });
      }
      throw err;
    }
    return c.json(result);
  },
);
