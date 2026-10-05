import { db } from '../db/client.js';
import { usageRecords } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { extractUsageFromEvents } from './usage-from-job-events.js';

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
