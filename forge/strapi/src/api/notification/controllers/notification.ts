import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';

const UID = 'api::notification.notification' as const;
const MARK_ALL_LIMIT = 500;
const DOC_ID_RE = /^[a-z0-9]{20,}$/;

function projectFilter(project: string | undefined): Record<string, any> {
  if (!project) return {};
  const isSlug = !DOC_ID_RE.test(project);
  return { project: isSlug ? { slug: { $eq: project } } : { documentId: { $eq: project } } };
}

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
    if (!result) return ctx.notFound('Notification not found');
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body?.data || {};
    const result = await strapi.documents(UID).update({ documentId: id, data });
    if (!result) return ctx.notFound('Notification not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Notification not found');
    return { data: result };
  },

  async markAllRead(ctx: Context) {
    const filters: any = { read: false, ...projectFilter(ctx.query.project as string | undefined) };
    const unread = await strapi.documents(UID).findMany({ filters, limit: MARK_ALL_LIMIT, populate: ['project'] });
    for (const n of unread) {
      await strapi.documents(UID).update({ documentId: n.documentId, data: { read: true } });
    }
    return { data: { updated: unread.length } };
  },

  async unreadCount(ctx: Context) {
    const filters = { read: false, ...projectFilter(ctx.query.project as string | undefined) };
    const count = await strapi.documents(UID).count({ filters });
    return { data: { count } };
  },
}));
