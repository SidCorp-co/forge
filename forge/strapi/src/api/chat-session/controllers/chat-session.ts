import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { extractUserIdFromToken } from '../../../lib/token-utils';

const UID = 'api::chat-session.chat-session' as const;

/**
 * Custom controller for chat-session.
 *
 * Routes use auth:false + is-forge-project policy, which means
 * Strapi's core controller strips relations from both input and output.
 * Override find/findOne/create to handle relations properly.
 */
export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const { populate, filters, sort, pagination } = ctx.query as any;

    // Scope sessions: by user (JWT) or by project (API key widget)
    const scopeFilters: any[] = [];
    if (ctx.state.user?.documentId) {
      scopeFilters.push({ user: { documentId: { $eq: ctx.state.user.documentId } } });
    } else if (ctx.state.forgeProject?.documentId) {
      scopeFilters.push({ project: { documentId: { $eq: ctx.state.forgeProject.documentId } } });
      scopeFilters.push({ source: { $eq: 'widget' } });
    } else if ((ctx.query as any).projectSlug) {
      scopeFilters.push({ project: { slug: { $eq: (ctx.query as any).projectSlug } } });
    }

    // Scope by widget user if hubToken provided (applies to both API-key and projectSlug paths)
    const hubToken = (ctx.query as any).hubToken;
    if (hubToken) {
      const widgetUserId = extractUserIdFromToken(hubToken);
      scopeFilters.push({ widgetUserId: { $eq: widgetUserId || '__none__' } });
    }
    if (filters) scopeFilters.push(filters);
    const mergedFilters = scopeFilters.length > 0 ? { $and: scopeFilters } : filters;

    const result = await strapi.documents(UID).findMany({
      populate: populate || undefined,
      filters: mergedFilters || undefined,
      sort: sort || undefined,
      limit: pagination?.pageSize ? Number(pagination.pageSize) : 25,
      start: pagination?.page ? (Number(pagination.page) - 1) * (Number(pagination.pageSize) || 25) : 0,
    });
    return { data: result };
  },

  async findOne(ctx: Context) {
    const { id } = ctx.params;
    const { populate } = ctx.query as any;
    const result = await strapi.documents(UID).findOne({
      documentId: id,
      populate: populate || undefined,
    });
    if (!result) {
      return ctx.notFound('Chat session not found');
    }
    return { data: result };
  },

  async create(ctx: Context) {
    const { title, messages, source, metadata, project } = ctx.request.body?.data || {};

    const data: any = { title, messages, source, metadata };
    if (project) data.project = project;
    if (ctx.state.user?.documentId) data.user = { documentId: ctx.state.user.documentId };

    const result = await strapi.documents(UID).create({ data });
    ctx.status = 201;
    return { data: result };
  },
}));
