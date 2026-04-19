import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';

const UID = 'api::agent.agent' as any;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    // Always populate definition
    if (!params.populate) params.populate = { definition: true };
    else if (typeof params.populate === 'object' && !Array.isArray(params.populate)) {
      (params.populate as any).definition = true;
    }
    const results = await strapi.documents(UID).findMany(params);
    const total = await strapi.documents(UID).count({ filters: params.filters });
    return {
      data: results,
      meta: paginationMeta(ctx.query, total, params.limit),
    };
  },

  async findOne(ctx: Context) {
    const { id } = ctx.params;
    const { populate } = ctx.query as any;
    const params: any = { documentId: id, populate: { definition: true } };
    if (populate === '*') {
      params.populate = '*';
    } else if (populate) {
      params.populate = populate;
    }
    const result = await strapi.documents(UID).findOne(params);
    if (!result) return ctx.notFound('Agent not found');
    return { data: result };
  },

  async create(ctx: Context) {
    const { name, type, project, ...rest } = ctx.request.body?.data || {};

    if (!name) return ctx.badRequest('name is required');
    if (!type) return ctx.badRequest('type is required');

    const data: any = { name, type, ...rest };

    if (ctx.state.forgeProject) {
      data.project = ctx.state.forgeProject.documentId;
    } else if (project) {
      data.project = project;
    }

    const result = await strapi.documents(UID).create({ data });
    ctx.status = 201;
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body?.data || {};
    const result = await strapi.documents(UID).update({ documentId: id, data });
    if (!result) return ctx.notFound('Agent not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Agent not found');
    return { data: result };
  },
}));
