/**
 * `GET /:projectId/integrations/gitlab/repositories?connectionId=&search=` — the GitLab projects a
 * connection's token can push to, for the project's repository picker.
 *
 * The GitLab twin of `GET /:projectId/integrations/github/repositories`: the same admin check
 * before the query is read, the same two grants on the connection, and a GitLab refusal answered by
 * name (a token GitLab rejects, a token without the scope to list) rather than as an empty list.
 */

import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { listGitLabRepositories } from '../integrations/gitlab/index.js';
import {
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  listBindingsForProject,
  listConnectionsForPrincipalUser,
  notFound,
} from '../integrations/index.js';
import { SourceHostCallError } from '../integrations/source-host/index.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

const repositoriesQuerySchema = z.object({
  connectionId: z.string().optional(),
  search: z.string().max(200).optional(),
});

// the admin check runs before the query is read, so a non-admin learns nothing from a 400
const projectAdmin: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await requireCan(
    actorFor(c.get('userId')),
    'project.admin',
    projectResource(c.req.param('projectId') ?? ''),
  );
  await next();
};

export const gitlabRepositoriesRoutes = new Hono<{ Variables: AuthVars }>();
gitlabRepositoriesRoutes.use('*', requireAuth(), assertEmailVerified());

/**
 * The connection this project's picker may list through, under the two grants GitHub's picker
 * reads: the project's own binding points at it (whoever owns it, a repick starts from a bound
 * row), or the caller sees it as a principal (binding a shared connection, before any binding to
 * this project exists). A connection under neither is refused as not found.
 */
async function gitlabConnectionForPicker(args: {
  projectId: string;
  userId: string;
  connectionId: string;
}): Promise<IntegrationConnectionRow | null> {
  const bound = (await listBindingsForProject(args.projectId)).find(
    (pair) => pair.binding.provider === 'gitlab' && pair.connection.id === args.connectionId,
  );
  if (bound) return bound.connection;
  const owned = (await listConnectionsForPrincipalUser(args.userId)).find(
    (x) => x.id === args.connectionId && x.provider === 'gitlab',
  );
  return owned ?? null;
}

function refusedByGitLab(err: SourceHostCallError, host: string): HTTPException {
  const said = err.detail ? `: ${err.detail}` : '';
  if (err.status === 401) {
    return new HTTPException(502, {
      message: `GitLab at ${host} did not accept this connection's token (HTTP 401)${said}; replace the token on the connection`,
      cause: { code: 'GITLAB_TOKEN_REJECTED', details: { httpStatus: err.status } },
    });
  }
  if (err.status === 403) {
    return new HTTPException(502, {
      message: `GitLab at ${host} refused this connection's token the project list (HTTP 403)${said}; the token needs the read_api or api scope`,
      cause: { code: 'GITLAB_TOKEN_SCOPE', details: { httpStatus: err.status } },
    });
  }
  return new HTTPException(502, {
    message: `${err.message}, so the projects this token reaches are unknown${said}`,
    cause: { code: 'GITLAB_REFUSED', details: { httpStatus: err.status } },
  });
}

gitlabRepositoriesRoutes.get(
  '/:projectId/integrations/gitlab/repositories',
  projectAdmin,
  zValidator('query', repositoriesQuerySchema),
  async (c) => {
    const projectId = c.req.param('projectId');
    const userId = c.get('userId');
    const { connectionId, search } = c.req.valid('query');
    if (!connectionId) throw badRequest({ connectionId: 'required' });

    const connection = await gitlabConnectionForPicker({ projectId, userId, connectionId });
    if (!connection) throw notFound('connection');

    const { token } = decryptConnectionSecrets<{ token?: string }>(connection);
    if (!token) throw badRequest({ connectionId: 'this GitLab connection holds no access token' });
    const config = (connection.config ?? {}) as { baseUrl?: unknown };
    const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
    const host = new URL(baseUrl ?? 'https://gitlab.com').host;

    try {
      return c.json(await listGitLabRepositories({ baseUrl, token, search }));
    } catch (err) {
      if (err instanceof SourceHostCallError) throw refusedByGitLab(err, host);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'TypeError')) {
        throw new HTTPException(502, {
          message: `GitLab at ${host} could not be reached (${err.message}), so the projects this token reaches are unknown`,
          cause: { code: 'GITLAB_UNREACHABLE', details: {} },
        });
      }
      throw err;
    }
  },
);
