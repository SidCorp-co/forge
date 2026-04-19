/**
 * Policy: is-forge-project
 * Validates authentication via:
 * 1. JWT Bearer token
 * 2. Global API key (FORGE_GLOBAL_API_KEY env var) via X-Forge-API-Key header
 * 3. Per-project API key via X-Forge-API-Key header
 */
import { errors } from '@strapi/utils';

const GLOBAL_API_KEY = process.env.FORGE_GLOBAL_API_KEY || '';

async function authenticateJwt(ctx): Promise<boolean> {
  if (ctx.state?.user) return true;

  const authHeader = ctx.request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7);
  try {
    const payload = await strapi.plugin('users-permissions').service('jwt').verify(token);
    const user = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { id: payload.id } });

    if (!user) return false;

    ctx.state.user = user;
    return true;
  } catch (err) {
    strapi.log.warn(`[is-forge-project] JWT verify failed: ${err}`);
    return false;
  }
}

export default async (policyContext) => {
  const ctx = policyContext;

  // 1. Try JWT (users-permissions)
  if (await authenticateJwt(ctx)) {
    return true;
  }

  // 2. Try Strapi API token (set by Strapi's built-in auth middleware)
  if (ctx.state?.auth?.strategy?.name === 'api-token') {
    return true;
  }

  const apiKey = ctx.request.headers['x-forge-api-key'] as string | undefined;
  if (!apiKey) {
    throw new errors.UnauthorizedError('Authentication required: provide JWT, API token, or X-Forge-API-Key');
  }

  // 2. Check global API key
  if (GLOBAL_API_KEY && apiKey === GLOBAL_API_KEY) {
    return true;
  }

  // 3. Check per-project API key
  const projects = await strapi.documents('api::project.project').findMany({
    filters: { apiKey: { $eq: apiKey } },
    limit: 1,
  });

  if (projects.length === 0) {
    throw new errors.PolicyError('Invalid API key');
  }

  ctx.state.forgeProject = projects[0];
  return true;
};
