import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';

const UID = 'api::agent-definition.agent-definition' as any;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    const results = await strapi.documents(UID).findMany(params);
    const total = await strapi.documents(UID).count({ filters: params.filters });
    return {
      data: results,
      meta: paginationMeta(ctx.query, total, params.limit),
    };
  },

  async findOne(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).findOne({ documentId: id });
    if (!result) return ctx.notFound('Agent definition not found');
    return { data: result };
  },

  async create(ctx: Context) {
    const data = ctx.request.body?.data || {};
    if (!data.name) return ctx.badRequest('name is required');
    if (!data.type) return ctx.badRequest('type is required');
    if (!data.promptTemplate) return ctx.badRequest('promptTemplate is required');

    const result = await strapi.documents(UID).create({ data });
    ctx.status = 201;
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body?.data || {};
    const result = await strapi.documents(UID).update({ documentId: id, data });
    if (!result) return ctx.notFound('Agent definition not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Agent definition not found');
    return { data: result };
  },
}));
