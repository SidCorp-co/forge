import { db } from '../db/client.js';
import { usageRecords } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { extractUsageFromEvents } from './usage-from-job-events.js';
import { estimateCost } from './usage-pricing.js';

/** Just the fields needed to attribute a usage row. */
interface MaterializeJobInput {
  id: string;
  agentSessionId: string | null;
  projectId: string;
}

/** Record a finished job's usage from the job events its owner, jobs, read and hands in. */
export async function materializeJobUsage(
  job: MaterializeJobInput,
  events: Parameters<typeof extractUsageFromEvents>[0],
): Promise<void> {
  try {
    // sessionId is the linkage cost-summary / the issues withCost rollup join on.
    if (!job.agentSessionId) return;

    const extracted = extractUsageFromEvents(events);
    if (!extracted) return; // no result line — nothing reliable to record

    await db
      .insert(usageRecords)
      .values({
        projectId: job.projectId,
        source: 'cli',
        model: extracted.model,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        cacheReadTokens: extracted.cacheReadTokens,
        cacheCreationTokens: extracted.cacheCreationTokens,
        estimatedCost: extracted.estimatedCost,
        requestCount: extracted.requestCount,
        sessionId: job.agentSessionId,
        jobId: job.id,
        recordedAt: extracted.recordedAt,
      })
      // Bare DO NOTHING: the only unique a job_id row can violate is the
      // partial index on job_id, so a second terminal/replay is a silent no-op.
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err, jobId: job.id }, 'usage-records: materialize failed');
  }
}

/**
 * Record a model call core made itself, with no job and no session behind it (a scheduled report's
 * narrative): source `api`, priced from the model the provider named, counted in the project's cost.
 */
export async function recordModelCallUsage(args: {
  projectId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requestCount: number;
  recordedAt: Date;
}): Promise<void> {
  const tokens = {
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cacheReadTokens: args.cacheReadTokens,
  };
  await db.insert(usageRecords).values({
    projectId: args.projectId,
    source: 'api',
    model: args.model,
    ...tokens,
    estimatedCost: estimateCost(args.model, tokens),
    requestCount: args.requestCount,
    recordedAt: args.recordedAt,
  });
}
