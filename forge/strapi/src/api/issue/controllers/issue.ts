import { factories } from '@strapi/strapi';
import type { Context } from 'koa';
import { enrichIssue } from '../../../services/ai-enrichment';
import { parseQueryParams, paginationMeta } from '../../../services/query-params';
import { estimateSessionCost, DEFAULT_MODEL, type SessionUsage } from '../../../services/pricing';
import { backfillSessionContextEmbeddings } from '../../../services/session-context-embedder';

const UID = 'api::issue.issue' as const;

/**
 * Resolve relation targetDocumentIds to { id, title, status } in a single batch query.
 * Mutates the issue objects in-place for efficiency.
 */
async function populateRelationTargets(issues: any[]): Promise<void> {
  // Collect all unique targetDocumentIds across all issues
  const allTargetIds = new Set<string>();
  for (const issue of issues) {
    const rels = issue?.relations;
    if (!Array.isArray(rels)) continue;
    for (const r of rels) {
      if (r.targetDocumentId) allTargetIds.add(r.targetDocumentId);
    }
  }
  if (allTargetIds.size === 0) return;

  // Single batch query
  const targets = await strapi.db.query(UID).findMany({
    where: { documentId: { $in: Array.from(allTargetIds) } },
    select: ['id', 'documentId', 'title', 'status'],
  });
  const targetMap = new Map(targets.map((t: any) => [t.documentId, t]));

  // Enrich each relation in-place
  for (const issue of issues) {
    const rels = issue?.relations;
    if (!Array.isArray(rels)) continue;
    for (const r of rels) {
      const t = targetMap.get(r.targetDocumentId);
      if (t) {
        r.targetId = t.id;
        r.targetTitle = t.title;
        r.targetStatus = t.status;
      }
    }
  }
}

/**
 * Default populate for issues — excludes heavy relations
 * (agentSessions with transcripts, activities, comments)
 * that have their own dedicated list endpoints.
 */
const DEFAULT_POPULATE = {
  project: true,
  labels: true,
  tasks: true,
  attachments: true,
  agentSessions: { fields: ['documentId', 'title', 'status', 'createdAt'] },
} as const;

export default factories.createCoreController(UID, ({ strapi }) => ({
  async find(ctx: Context) {
    const params = parseQueryParams(ctx.query);
    if (params.populate === '*') params.populate = { ...DEFAULT_POPULATE };
    const results = await strapi.documents(UID).findMany(params);
    const total = await strapi.documents(UID).count({ filters: params.filters });
    await populateRelationTargets(results);
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
      params.populate = { ...DEFAULT_POPULATE };
    } else if (populate) {
      params.populate = populate;
    }
    const result = await strapi.documents(UID).findOne(params);
    if (!result) return ctx.notFound('Issue not found');
    await populateRelationTargets([result]);
    return { data: result };
  },

  async create(ctx: Context) {
    const { title, description, status, priority, reportedBy, project } =
      ctx.request.body?.data || {};

    if (!title) return ctx.badRequest('title is required');

    const data: any = {
      title,
      description,
      status: status || 'open',
      priority: priority || 'none',
      reportedBy,
    };

    // Attach project from API key context or from request body
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
    if (!result) return ctx.notFound('Issue not found');
    return { data: result };
  },

  async delete(ctx: Context) {
    const { id } = ctx.params;
    const result = await strapi.documents(UID).delete({ documentId: id });
    if (!result) return ctx.notFound('Issue not found');
    return { data: result };
  },

  async costSummary(ctx: Context) {
    const { id } = ctx.params;

    const issue = await strapi.documents(UID).findOne({ documentId: id });
    if (!issue) return ctx.notFound('Issue not found');

    const sessions = await strapi.db.query('api::agent-session.agent-session').findMany({
      where: { issues: { documentId: id } },
      select: ['id', 'documentId', 'title', 'status', 'usage', 'metadata', 'createdAt'],
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalTurns = 0;
    let totalCost = 0;
    const stepMap = new Map<string, { inputTokens: number; outputTokens: number; cost: number; turns: number; sessionCount: number }>();
    const sessionDetails: { documentId: string; title: string; step: string; model: string; cost: number; inputTokens: number; outputTokens: number; turns: number }[] = [];

    for (const s of sessions) {
      const usage = s.usage as SessionUsage | null;
      if (!usage || (!usage.inputTotal && !usage.outputTotal)) continue;

      const model = (s.metadata as any)?.model || DEFAULT_MODEL;
      const step = (s.metadata as any)?.skill || 'manual';
      const cost = estimateSessionCost(usage, model);

      totalInputTokens += usage.inputTotal || 0;
      totalOutputTokens += usage.outputTotal || 0;
      totalCacheReadTokens += usage.cacheRead || 0;
      totalCacheWriteTokens += usage.cacheWrite || 0;
      totalTurns += usage.turns || 0;
      totalCost += cost;

      const existing = stepMap.get(step);
      if (existing) {
        existing.inputTokens += usage.inputTotal || 0;
        existing.outputTokens += usage.outputTotal || 0;
        existing.cost += cost;
        existing.turns += usage.turns || 0;
        existing.sessionCount += 1;
      } else {
        stepMap.set(step, {
          inputTokens: usage.inputTotal || 0,
          outputTokens: usage.outputTotal || 0,
          cost,
          turns: usage.turns || 0,
          sessionCount: 1,
        });
      }

      sessionDetails.push({
        documentId: s.documentId,
        title: s.title,
        step,
        model,
        cost: Math.round(cost * 10000) / 10000,
        inputTokens: usage.inputTotal || 0,
        outputTokens: usage.outputTotal || 0,
        turns: usage.turns || 0,
      });
    }

    const byStep = Array.from(stepMap.entries()).map(([step, data]) => ({
      step,
      ...data,
      cost: Math.round(data.cost * 10000) / 10000,
    }));

    return {
      data: {
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        totalTurns,
        totalCost: Math.round(totalCost * 10000) / 10000,
        sessionCount: sessionDetails.length,
        byStep,
        sessions: sessionDetails,
      },
    };
  },

  async pipelineTiming(ctx: Context) {
    const { from, to } = ctx.query as { from?: string; to?: string };

    // Build filters
    interface TimingFilters {
      project?: { documentId: string };
      updatedAt?: { $gte?: string; $lte?: string };
    }
    const filters: TimingFilters = {};
    if (ctx.state.forgeProject) {
      filters.project = { documentId: ctx.state.forgeProject.documentId };
    }
    if (from || to) {
      filters.updatedAt = {};
      if (from) filters.updatedAt.$gte = new Date(from).toISOString();
      if (to) filters.updatedAt.$lte = new Date(to + 'T23:59:59.999Z').toISOString();
    }

    const issues = await strapi.documents(UID).findMany({
      filters,
      fields: ['documentId', 'title', 'changeHistory', 'createdAt', 'updatedAt'],
      limit: 1000,
    });

    // Parse changeHistory to extract step durations
    type StepEntry = { step: string; duration: number; issueId: number; documentId: string; title: string };
    const stepEntries: StepEntry[] = [];

    for (const issue of issues) {
      const doc = issue as { id: number; documentId: string; title: string; changeHistory?: unknown[] };
      const history = doc.changeHistory ?? [];
      // Extract status transitions with timestamps
      const transitions: { status: string; at: number }[] = [];

      for (const entry of history) {
        if (typeof entry === 'object' && entry !== null && 'field' in entry && (entry as Record<string, unknown>).field === 'status') {
          const rec = entry as Record<string, string>;
          const t = new Date(rec.at).getTime();
          if (!isNaN(t)) transitions.push({ status: rec.to, at: t });
        } else if (typeof entry === 'string' && entry.includes('changed status')) {
          const tsMatch = entry.match(/^\[(.+?)\]/);
          const toMatch = entry.match(/to "(.+?)"/);
          if (tsMatch && toMatch) {
            const t = new Date(tsMatch[1]).getTime();
            if (!isNaN(t)) transitions.push({ status: toMatch[1], at: t });
          }
        }
      }

      transitions.sort((a, b) => a.at - b.at);

      for (let i = 0; i < transitions.length - 1; i++) {
        const duration = transitions[i + 1].at - transitions[i].at;
        // Skip sub-second transitions (auto-skipped statuses)
        if (duration < 1000) continue;
        const step = `${transitions[i].status}→${transitions[i + 1].status}`;
        stepEntries.push({
          step,
          duration,
          issueId: doc.id,
          documentId: doc.documentId,
          title: doc.title,
        });
      }
    }

    // Aggregate per step
    const stepMap = new Map<string, { durations: number[]; entries: StepEntry[] }>();
    for (const entry of stepEntries) {
      const existing = stepMap.get(entry.step);
      if (existing) {
        existing.durations.push(entry.duration);
        existing.entries.push(entry);
      } else {
        stepMap.set(entry.step, { durations: [entry.duration], entries: [entry] });
      }
    }

    const steps = Array.from(stepMap.entries()).map(([step, { durations, entries }]) => {
      durations.sort((a, b) => a - b);
      const count = durations.length;
      const avg = durations.reduce((a, b) => a + b, 0) / count;
      const median = count % 2 === 0
        ? (durations[count / 2 - 1] + durations[count / 2]) / 2
        : durations[Math.floor(count / 2)];
      const p90Index = Math.min(Math.ceil(count * 0.9) - 1, count - 1);
      const p90 = durations[p90Index];
      const outlierThreshold = p90 * 2;
      const outliers = entries
        .filter((e) => e.duration > outlierThreshold)
        .map((e) => ({ issueId: e.issueId, documentId: e.documentId, title: e.title, duration: e.duration }));

      return { step, avg: Math.round(avg), p90, median, count, outliers };
    });

    return {
      data: {
        steps,
        totalIssuesAnalyzed: issues.length,
        window: {
          from: from || null,
          to: to || null,
        },
      },
    };
  },

  async enrich(ctx: Context) {
    const { id } = ctx.params;

    const issue = await strapi.documents(UID).findOne({
      documentId: id,
      populate: ['project'],
    });

    if (!issue) return ctx.notFound('Issue not found');
    if (!issue.project) return ctx.badRequest('Issue has no project');

    // Fire and forget — enrichIssue manages status transitions and broadcasts
    setImmediate(() => {
      enrichIssue(strapi, id).catch((err) => {
        strapi.log.error(`Enrichment failed for issue ${id}: ${err}`);
      });
    });

    return { data: { documentId: id, status: 'processing' } };
  },

  async backfillSessionContext(ctx: Context) {
    const projectId = ctx.query.projectId as string | undefined;
    const result = await backfillSessionContextEmbeddings(strapi, projectId || undefined);
    return { data: result };
  },
}));
