import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

export type ApiKeyProject = {
  id: string;
  slug: string;
  name: string;
};

export type ApiKeyVars = { project: ApiKeyProject };

const HEADER = 'x-forge-api-key';

export function requireProjectApiKey(): MiddlewareHandler<{ Variables: ApiKeyVars }> {
  return async (c, next) => {
    const key = c.req.header(HEADER) ?? c.req.header('X-Forge-API-Key');
    if (!key || key.length < 16) {
      throw new HTTPException(401, {
        message: 'api key required',
        cause: { code: 'API_KEY_REQUIRED' },
      });
    }

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, name: projects.name })
      .from(projects)
      .where(eq(projects.apiKey, key))
      .limit(1);

    if (!project) {
      throw new HTTPException(401, {
        message: 'invalid api key',
        cause: { code: 'INVALID_API_KEY' },
      });
    }

    c.set('project', project);
    await next();
  };
}
