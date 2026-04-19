import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { estimateCost } from '../../../services/pricing';
import { ingestCliUsage } from '../../../services/cli-ingestion';
import { bulkCreate } from '../services/usage-bulk-import';
import { summary } from '../services/usage-analytics';

const UID = 'api::usage-record.usage-record' as const;

function getProjectFilter(ctx: Context): Record<string, unknown> | null {
  if ((ctx.state as any).forgeProject) {
    return { project: { documentId: { $eq: (ctx.state as any).forgeProject.documentId } } };
  }
  return null;
}

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const { source, model, from, to, page = 1, pageSize = 25 } = ctx.query as Record<string, string>;
    const filters: Record<string, unknown> = {};

    const projectFilter = getProjectFilter(ctx);
    if (projectFilter) Object.assign(filters, projectFilter);

    if (source) filters.source = { $eq: source };
    if (model) filters.model = { $containsi: model };
    if (from || to) {
      const recordedAt: Record<string, string> = {};
      if (from) recordedAt.$gte = from;
      if (to) recordedAt.$lte = to;
      filters.recordedAt = recordedAt;
    }

    const limit = Number(pageSize);
    const offset = (Number(page) - 1) * limit;
    const results = await strapi.documents(UID).findMany({ filters, sort: { recordedAt: 'desc' }, limit, offset });
    const count = await strapi.documents(UID).count({ filters });

    return { data: results, meta: { pagination: { page: Number(page), pageSize: limit, total: count } } };
  },

  async create(ctx: Context) {
    const { data } = ctx.request.body as { data: Record<string, unknown> };

    if (!data?.recordedAt) return ctx.badRequest('recordedAt is required');

    // Server-side cost calculation
    if (data.model && (data.inputTokens || data.outputTokens)) {
      data.estimatedCost = estimateCost(
        data.model as string,
        (data.inputTokens as number) || 0,
        (data.outputTokens as number) || 0,
      );
    }

    if ((ctx.state as any).forgeProject) {
      data.project = (ctx.state as any).forgeProject.documentId;
    }

    const result = await strapi.documents(UID).create({ data: data as any });
    ctx.status = 201;
    return { data: result };
  },

  async bulkCreate(ctx: Context) {
    const { records } = ctx.request.body as { records: Record<string, unknown>[] };

    if (!Array.isArray(records) || records.length === 0) {
      return ctx.badRequest('records array is required');
    }

    const inserted = await bulkCreate(strapi, records);
    ctx.status = 201;
    return { meta: { count: inserted } };
  },

  async summary(ctx: Context) {
    return summary(ctx, strapi);
  },

  async ingestCli() {
    const result = await ingestCliUsage(strapi);
    return { data: result };
  },
}));
