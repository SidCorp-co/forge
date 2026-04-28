/**
 * Widget API key middleware.
 *
 * Keys are stored in `projects.api_key` as plaintext and looked up by
 * equality. That trade-off is documented in
 * [ADR 0013](../../../../docs/decisions/0013-widget-api-key-storage.md) —
 * the secret is embedded in the page that loads the widget, so server-side
 * hashing does not change the threat model. Rotation (POST
 * /api/projects/:id/api-key/rotate) is the mitigation against a DB leak.
 */

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

export function requireProjectApiKey(): MiddlewareHandler<{ Variables: ApiKeyVars }> {
  return async (c, next) => {
    // Hono lowercases header names internally — a single lookup covers
    // every casing the widget snippet might emit.
    const key = c.req.header('x-forge-api-key');
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
