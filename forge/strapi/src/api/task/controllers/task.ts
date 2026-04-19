import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';

const UID = 'api::task.task' as const;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async create(ctx: Context) {
    const { title, description, status, priority, assignee, isAgentTask, agentStatus, agentLog, acceptanceCriteria, issue, project } =
      ctx.request.body?.data || {};

    if (!title) return ctx.badRequest('title is required');

    const data: any = {
      title,
      description,
      status: status || 'backlog',
      priority: priority || 'none',
      assignee,
      isAgentTask: isAgentTask || false,
      agentStatus,
      agentLog,
      acceptanceCriteria,
    };

    if (ctx.state.forgeProject) {
      data.project = ctx.state.forgeProject.documentId;
    } else if (project) {
      data.project = project;
    }
    if (issue) data.issue = issue;

    const result = await strapi.documents(UID).create({ data });
    ctx.status = 201;
    return { data: result };
  },

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
    const { populate } = ctx.query as any;
    const params: any = { documentId: id };
    if (populate === '*') {
      params.populate = '*';
    } else if (populate) {
      params.populate = populate;
    }
    const result = await strapi.documents(UID).findOne(params);
    if (!result) return ctx.notFound('Task not found');
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body?.data || {};
    const result = await strapi.documents(UID).update({ documentId: id, data });
    if (!result) return ctx.notFound('Task not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Task not found');
    ctx.status = 204;
    ctx.body = null;
  },
}));
