import { db } from '../db/client.js';
import { type UsageSource, usageRecords } from '../db/schema.js';
import { estimateCost } from './pricing.js';
import type { UsageRecordRow } from './read.js';

/** One reported usage entry; `estimatedCost` is priced from the model when absent. */
export type UsageRecordInput = {
  projectId?: string | null | undefined;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestCount: number;
  sessionId?: string | null | undefined;
  projectName?: string | null | undefined;
  recordedAt: Date;
  estimatedCost?: number | undefined;
};

function valuesOf(input: UsageRecordInput, source: UsageSource) {
  return {
    projectId: input.projectId ?? null,
    source,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    estimatedCost:
      input.estimatedCost ??
      estimateCost(input.model, {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheCreationTokens: input.cacheCreationTokens,
      }),
    requestCount: input.requestCount,
    sessionId: input.sessionId ?? null,
    projectName: input.projectName ?? null,
    recordedAt: input.recordedAt,
  };
}

/** Records one usage entry; answers the stored row. */
export async function recordUsage(input: UsageRecordInput): Promise<UsageRecordRow> {
  const [inserted] = await db
    .insert(usageRecords)
    .values(valuesOf(input, input.source))
    .returning();
  if (!inserted) throw new Error('usage_records: insert returned no row');
  return inserted;
}

/** Records a batch of usage entries, each under `source` when given; answers how many were stored. */
export async function recordUsageBatch(
  inputs: readonly UsageRecordInput[],
  source?: UsageSource,
): Promise<number> {
  const inserted = await db
    .insert(usageRecords)
    .values(inputs.map((r) => valuesOf(r, source ?? r.source)))
    .returning({ id: usageRecords.id });
  return inserted.length;
}
