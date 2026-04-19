import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';

const UID = 'api::schedule.schedule' as any;

function validateMinInterval(cron: string): string | null {
  try {
    const cronParser = require('cron-parser');
    const interval = cronParser.parseExpression(cron);
    const t1 = interval.next().getTime();
    const t2 = interval.next().getTime();
    const diffMs = t2 - t1;
    if (diffMs < 3600_000) {
      return `Minimum schedule interval is 1 hour. This cron runs every ${Math.round(diffMs / 60_000)} minutes.`;
    }
    return null;
  } catch {
    return 'Invalid cron expression';
  }
}

export default factories.createCoreController(UID, ({ strapi }: any) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    const results = await (strapi as any).documents(UID).findMany({ ...params, populate: ['project'] });
    const total = await (strapi as any).documents(UID).count({ filters: params.filters });
    return {
      data: results,
      meta: paginationMeta(ctx.query, total, params.limit),
    };
  },

  async findOne(ctx: Context) {
    const { id } = ctx.params;
    const result = await (strapi as any).documents(UID).findOne({ documentId: id, populate: ['project'] });
    if (!result) return ctx.notFound('Schedule not found');
    return { data: result };
  },

  async create(ctx: Context) {
    const data = ctx.request.body?.data || {};
    if (data.cron) {
      const err = validateMinInterval(data.cron);
      if (err) { ctx.status = 400; return { error: { message: err } }; }
      if (data.enabled !== false) {
        const cronParser = require('cron-parser');
        const interval = cronParser.parseExpression(data.cron);
        data.nextRunAt = interval.next().toISOString();
      }
    }
    const result = await (strapi as any).documents(UID).create({ data, populate: ['project'] });
    return { data: result };
  },

  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body?.data || {};
    if (data.cron) {
      const err = validateMinInterval(data.cron);
      if (err) { ctx.status = 400; return { error: { message: err } }; }
      const cronParser = require('cron-parser');
      const interval = cronParser.parseExpression(data.cron);
      data.nextRunAt = interval.next().toISOString();
    }
    const result = await (strapi as any).documents(UID).update({ documentId: id, data, populate: ['project'] });
    if (!result) return ctx.notFound('Schedule not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await (strapi as any).documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Schedule not found');
    return { data: result };
  },

  async run(ctx: Context) {
    const { id } = ctx.params;
    const schedule = await (strapi as any).documents(UID).findOne({
      documentId: id,
      populate: ['project'],
    });
    if (!schedule) return ctx.notFound('Schedule not found');

    try {
      const { dispatchSchedule } = require('../../../services/schedule-executor');
      const sessionId = await dispatchSchedule(strapi, schedule);
      return { data: { sessionId, message: 'Schedule triggered' } };
    } catch (err: any) {
      ctx.status = 500;
      return { error: { message: err.message || 'Failed to dispatch schedule' } };
    }
  },
}));
