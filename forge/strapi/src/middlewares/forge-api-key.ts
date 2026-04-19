import type { Core } from '@strapi/strapi';

const forgeApiKey = (config: any, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx, next) => {
    // MCP endpoint handles its own auth
    if (ctx.path === '/mcp') return next();

    const apiKey = ctx.request.headers['x-forge-api-key'] as string | undefined;

    if (!apiKey) {
      return next();
    }

    // Check global API key first
    const globalKey = process.env.FORGE_GLOBAL_API_KEY || '';
    if (globalKey && apiKey === globalKey) {
      return next();
    }

    // Look up project by API key
    const projects = await strapi.documents('api::project.project').findMany({
      filters: { apiKey: { $eq: apiKey } },
      limit: 1,
    });

    if (projects.length === 0) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid API key' };
      return;
    }

    // Attach project to state for downstream use
    ctx.state.forgeProject = projects[0];

    await next();
  };
};

export default forgeApiKey;
