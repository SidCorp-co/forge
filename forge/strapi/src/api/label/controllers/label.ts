import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams } from '../../../services/query-params';

const UID = 'api::label.label' as any;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    const results = await strapi.documents(UID).findMany(params);
    return { data: results };
  },

  async create(ctx: Context) {
    const { name, color, description, project } = ctx.request.body?.data || {};
    if (!name || !color) return ctx.badRequest('name and color are required');

    const result = await strapi.documents(UID).create({
      data: { name, color, description, project },
    });
    ctx.status = 201;
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const { name, color, description } = ctx.request.body?.data || {};

    const result = await strapi.documents(UID).update({
      documentId: id,
      data: { ...(name !== undefined && { name }), ...(color !== undefined && { color }), ...(description !== undefined && { description }) },
    });
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    await strapi.documents(UID).delete({ documentId: id });
    ctx.status = 204;
    return null;
  },
}));
