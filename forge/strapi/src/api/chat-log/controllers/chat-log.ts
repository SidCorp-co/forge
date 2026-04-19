import { factories } from '@strapi/strapi';

const UID = 'api::chat-log.chat-log' as any;
const PROJECT_UID = 'api::project.project' as any;

function formatChatLog(log: any, opts?: { truncateReply?: number }) {
  return {
    id: log.documentId,
    documentId: log.documentId,
    createdAt: log.createdAt,
    sessionId: log.sessionId,
    projectSlug: log.projectSlug,
    source: log.source || 'web',
    query: log.query,
    condensedQuery: log.condensedQuery,
    queryIntent: log.queryIntent,
    reply: opts?.truncateReply ? log.reply?.slice(0, opts.truncateReply) : log.reply,
    model: log.model,
    durationMs: log.durationMs,
    iterations: log.iterations,
    usage: log.usage,
    toolCalls: log.toolCalls,
    ragContext: log.ragContext,
    error: log.error,
    qualitySignals: log.qualitySignals,
    qaRating: log.qaRating,
    qaNotes: log.qaNotes,
  };
}

function requireChatLogAccess(ctx: any): boolean {
  // Global API key has full access
  const globalKey = process.env.FORGE_GLOBAL_API_KEY || '';
  const apiKey = ctx.request.headers['x-forge-api-key'];
  if (globalKey && apiKey === globalKey) return true;

  const user = ctx.state?.user;
  if (user && user.chatLogAccess === true) return true;
  ctx.status = 403;
  ctx.body = { error: 'Chat log access denied' };
  return false;
}

export default factories.createCoreController(UID, () => ({
  /**
   * GET /api/chat-logs/recent?limit=20
   * Returns recent chat logs for the project identified by X-Forge-API-Key.
   * Includes queryIntent, condensedQuery, ragContext, toolCalls for debugging.
   */
  async recent(ctx) {
    const strapi = globalThis.strapi;
    const apiKey = ctx.request.headers['x-forge-api-key'];
    if (!apiKey) return ctx.unauthorized('Missing X-Forge-API-Key header');

    const limit = Math.min(parseInt(String(ctx.query.limit || '20'), 10) || 20, 100);
    const filters: any = {};

    // Global API key: return all logs (optionally filtered by ?projectSlug=)
    const globalKey = process.env.FORGE_GLOBAL_API_KEY || '';
    if (globalKey && apiKey === globalKey) {
      if (ctx.query.projectSlug) filters.projectSlug = { $eq: ctx.query.projectSlug };
      if (ctx.query.sessionId) filters.sessionId = { $eq: ctx.query.sessionId };
    } else {
      // Project-specific API key
      const projects: any[] = await strapi.documents(PROJECT_UID).findMany({
        filters: { apiKey: { $eq: apiKey } },
      });
      if (!projects.length) return ctx.unauthorized('Invalid API key');
      filters.projectSlug = { $eq: projects[0].slug };
    }

    const logs = await strapi.documents(UID).findMany({
      filters,
      sort: 'createdAt:desc' as any,
      limit,
    });

    ctx.body = logs.map((log: any) => formatChatLog(log, { truncateReply: 500 }));
  },

  /**
   * GET /api/chat-logs
   * Paginated list with filters. Requires JWT or X-Forge-API-Key (via is-forge-project policy).
   * Query params: intent, source, qaRating, dateFrom, dateTo, page, pageSize
   */
  async find(ctx) {
    if (!requireChatLogAccess(ctx)) return;

    const strapi = globalThis.strapi;
    const { intent, source, qaRating, dateFrom, dateTo, page, pageSize, projectSlug } = ctx.query as Record<string, string>;

    const filters: any = {};

    if (projectSlug) filters.projectSlug = { $eq: projectSlug };
    if (intent) filters.queryIntent = { $eq: intent };
    if (source) filters.source = { $eq: source };
    if (qaRating) filters.qaRating = { $eq: qaRating };

    if (dateFrom || dateTo) {
      filters.createdAt = {};
      if (dateFrom) filters.createdAt.$gte = dateFrom;
      if (dateTo) filters.createdAt.$lte = dateTo;
    }

    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize || '25', 10) || 25));
    const start = (pageNum - 1) * pageSizeNum;

    const [logs, total] = await Promise.all([
      strapi.documents(UID).findMany({
        filters,
        sort: 'createdAt:desc' as any,
        limit: pageSizeNum,
        start,
      }),
      strapi.documents(UID).count({ filters }),
    ]);

    ctx.body = {
      data: logs.map((log: any) => formatChatLog(log)),
      meta: {
        pagination: {
          page: pageNum,
          pageSize: pageSizeNum,
          total,
          pageCount: Math.ceil(total / pageSizeNum),
        },
      },
    };
  },

  /**
   * GET /api/chat-logs/:id
   * Returns a single chat log by documentId.
   */
  async findOne(ctx) {
    if (!requireChatLogAccess(ctx)) return;

    const strapi = globalThis.strapi;
    const { id } = ctx.params;

    const log = await strapi.documents(UID).findOne({ documentId: id });
    if (!log) return ctx.notFound('Chat log not found');

    ctx.body = formatChatLog(log);
  },

  /**
   * PATCH /api/chat-logs/:id
   * Update qaRating and/or qaNotes for a chat log.
   */
  async update(ctx) {
    if (!requireChatLogAccess(ctx)) return;

    const strapi = globalThis.strapi;
    const { id } = ctx.params;
    const body = ctx.request.body as any;

    const existing = await strapi.documents(UID).findOne({ documentId: id });
    if (!existing) return ctx.notFound('Chat log not found');

    const updateData: any = {};
    if ('qaRating' in body) {
      const validRatings = ['good', 'bad', 'flagged', null];
      if (!validRatings.includes(body.qaRating)) {
        return ctx.badRequest('qaRating must be one of: good, bad, flagged, or null');
      }
      updateData.qaRating = body.qaRating;
    }
    if ('qaNotes' in body) {
      updateData.qaNotes = body.qaNotes ?? null;
    }

    if (Object.keys(updateData).length === 0) {
      return ctx.badRequest('Provide at least one of: qaRating, qaNotes');
    }

    const updated = await strapi.documents(UID).update({
      documentId: id,
      data: updateData,
    });

    ctx.body = {
      id: updated.documentId,
      qaRating: updated.qaRating,
      qaNotes: updated.qaNotes,
    };
  },

  /**
   * GET /api/chat-logs/flagged
   * Returns flagged/bad logs formatted as eval test cases.
   */
  async flagged(ctx) {
    const strapi = globalThis.strapi;
    const { projectSlug, limit } = ctx.query as Record<string, string>;

    const limitNum = Math.min(200, Math.max(1, parseInt(limit || '50', 10) || 50));

    const filters: any = {
      qaRating: { $in: ['flagged', 'bad'] },
    };
    if (projectSlug) filters.projectSlug = { $eq: projectSlug };

    const logs = await strapi.documents(UID).findMany({
      filters,
      sort: 'createdAt:desc' as any,
      limit: limitNum,
    });

    // Format as eval test cases
    ctx.body = logs.map((log: any) => ({
      id: log.documentId,
      createdAt: log.createdAt,
      projectSlug: log.projectSlug,
      sessionId: log.sessionId,
      source: log.source || 'web',
      qaRating: log.qaRating,
      qaNotes: log.qaNotes,
      // Test case fields
      input: {
        query: log.query,
        condensedQuery: log.condensedQuery,
        queryIntent: log.queryIntent,
      },
      expected: {
        // Notes from QA reviewer as guidance for expected behavior
        notes: log.qaNotes,
      },
      actual: {
        reply: log.reply,
        model: log.model,
        durationMs: log.durationMs,
        iterations: log.iterations,
        toolCalls: log.toolCalls,
        ragContext: log.ragContext,
        usage: log.usage,
        error: log.error,
      },
    }));
  },
}));
