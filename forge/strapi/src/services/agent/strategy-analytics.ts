/**
 * Lightweight strategy usage analytics — fire-and-forget tracking per search invocation.
 */

const ANALYTIC_UID = 'api::retrieval-analytic.retrieval-analytic' as any;

export type RetrievalStrategy = 'semantic' | 'keyword' | 'graph' | 'hybrid' | 'auto';

export function trackStrategyUsage(
  strapi: any,
  projectId: string,
  strategy: RetrievalStrategy,
  query: string,
  resultCount: number,
  topScore: number,
  latencyMs: number,
  resolvedStrategy?: string,
): void {
  // Fire-and-forget — don't await, don't block the search response
  strapi.documents(ANALYTIC_UID).create({
    data: {
      strategy,
      resolvedStrategy: resolvedStrategy || strategy,
      query: query.slice(0, 500),
      resultCount,
      topScore: Math.round(topScore * 1000) / 1000,
      latencyMs,
      project: { documentId: projectId },
    },
  }).catch((err: any) => {
    strapi.log.warn(`[strategy-analytics] tracking failed: ${err.message || err}`);
  });
}
