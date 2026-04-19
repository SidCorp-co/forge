import type { Context } from 'koa';

const UID = 'api::usage-record.usage-record' as const;

type UsageStats = { input: number; output: number; cost: number; requests: number };

export function makeStats(): UsageStats {
  return { input: 0, output: 0, cost: 0, requests: 0 };
}

export function accumulate(map: Map<string, UsageStats>, key: string, stats: UsageStats): void {
  const entry = map.get(key) ?? makeStats();
  entry.input += stats.input;
  entry.output += stats.output;
  entry.cost += stats.cost;
  entry.requests += stats.requests;
  map.set(key, entry);
}

export async function summary(ctx: Context, strapi: any) {
  const { days = '7' } = ctx.query as Record<string, string>;
  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const filters: Record<string, unknown> = { recordedAt: { $gte: since.toISOString() } };
  const projectFilter = getProjectFilter(ctx);
  if (projectFilter) Object.assign(filters, projectFilter);

  const PAGE_SIZE = 1000;
  const allRecords: any[] = [];
  let offset = 0;
  let batch: any[];
  do {
    batch = await strapi.documents(UID).findMany({ filters, limit: PAGE_SIZE, offset });
    allRecords.push(...batch);
    offset += PAGE_SIZE;
  } while (batch.length === PAGE_SIZE);

  const dailyMap = new Map<string, UsageStats>();
  const modelMap = new Map<string, UsageStats>();
  const sourceMap = new Map<string, UsageStats>();
  let totalInput = 0, totalOutput = 0, totalCost = 0, totalRequests = 0;

  for (const r of allRecords) {
    const day = (r.recordedAt as string)?.slice(0, 10) ?? 'unknown';
    const model = r.model ?? 'unknown';
    const source = r.source ?? 'unknown';
    const stats: UsageStats = {
      input: r.inputTokens ?? 0,
      output: r.outputTokens ?? 0,
      cost: r.estimatedCost ?? 0,
      requests: r.requestCount ?? 1,
    };

    totalInput += stats.input;
    totalOutput += stats.output;
    totalCost += stats.cost;
    totalRequests += stats.requests;

    accumulate(dailyMap, day, stats);
    accumulate(modelMap, model, stats);
    accumulate(sourceMap, source, stats);
  }

  const daily = Array.from(dailyMap.entries())
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const byModel = Array.from(modelMap.entries())
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.cost - a.cost);
  const bySource = Array.from(sourceMap.entries())
    .map(([source, stats]) => ({ source, ...stats }));

  return {
    data: {
      totals: { inputTokens: totalInput, outputTokens: totalOutput, estimatedCost: totalCost, requests: totalRequests },
      daily,
      byModel,
      bySource,
    },
  };
}

function getProjectFilter(ctx: Context): Record<string, unknown> | null {
  if ((ctx.state as any).forgeProject) {
    return { project: { documentId: { $eq: (ctx.state as any).forgeProject.documentId } } };
  }
  return null;
}
