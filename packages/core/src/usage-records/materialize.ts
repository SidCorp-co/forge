import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobEvents, usageRecords } from '../db/schema.js';
import { logger } from '../logger.js';
import { extractUsageFromEvents } from './from-job-events.js';

/** Just the fields needed to attribute a usage row. */
export interface MaterializeJobInput {
  id: string;
  agentSessionId: string | null;
  projectId: string;
}

export async function materializeJobUsage(job: MaterializeJobInput): Promise<void> {
  try {
    // sessionId is the linkage cost-summary / the issues withCost rollup join on.
    if (!job.agentSessionId) return;

    const events = await db
      .select({ kind: jobEvents.kind, data: jobEvents.data, ts: jobEvents.ts })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(asc(jobEvents.seq));

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
