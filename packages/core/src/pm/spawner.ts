import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pmConfig, pmDecisions } from '../db/schema.js';
import { noPromptMessage, POOL_JOB_NO_PROMPT } from '../jobs/pool-served.js';
import { logger } from '../logger.js';

export type SpawnCause =
  | 'job-failed'
  | 'pipeline-stalled'
  | 'needs-info'
  | 'queue-pressure'
  | 'graph-changed'
  | 'tick'
  | 'agent-cron'
  | 'operator'
  | 'operator-reply';

export interface SpawnPmSessionInput {
  projectId: string;
  cause: SpawnCause;
  eventRef?: Record<string, unknown>;
  actorUserId?: string;
}

/** What the operator route answers a `pool-job-no-prompt` refusal with. */
export const PM_NO_PROMPT_MESSAGE = noPromptMessage('pm');

export type SpawnPmSessionResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'disabled' | 'trigger-masked' | 'rate-limited' | 'pool-job-no-prompt' };

const MASKABLE_CAUSE_TO_TRIGGER_KEY: Partial<Record<SpawnCause, string>> = {
  'job-failed': 'jobFailed',
  'pipeline-stalled': 'pipelineStalled',
  'needs-info': 'needsInfo',
  'queue-pressure': 'queuePressure',
  'graph-changed': 'graphChanged',
};

const RATE_LIMIT_BYPASS: ReadonlySet<SpawnCause> = new Set(['operator', 'operator-reply']);

/**
 * Three guards in order — `pm_config.enabled`, the per-cause trigger mask, the
 * hourly rate limit (operators bypass it) — each answering by reason. A spawn
 * past all three is refused `pool-job-no-prompt`: nothing builds a PM prompt,
 * and the job pool runs only the prompt a job is minted with.
 */
export async function spawnPmSession(input: SpawnPmSessionInput): Promise<SpawnPmSessionResult> {
  const [config] = await db
    .select()
    .from(pmConfig)
    .where(eq(pmConfig.projectId, input.projectId))
    .limit(1);

  if (!config?.enabled) {
    return { ok: false, reason: 'disabled' };
  }

  const triggerKey = MASKABLE_CAUSE_TO_TRIGGER_KEY[input.cause];
  if (triggerKey) {
    const triggers = (config.eventTriggers ?? {}) as Record<string, unknown>;
    if (triggers[triggerKey] === false) {
      return { ok: false, reason: 'trigger-masked' };
    }
  }

  if (!RATE_LIMIT_BYPASS.has(input.cause)) {
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pmDecisions)
      .where(
        and(
          eq(pmDecisions.projectId, input.projectId),
          gte(pmDecisions.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if (count >= config.maxRunsPerHour) {
      logger.info(
        { projectId: input.projectId, cause: input.cause, count, limit: config.maxRunsPerHour },
        'pm.spawn.rate_limited',
      );
      return { ok: false, reason: 'rate-limited' };
    }
  }

  logger.warn(
    { projectId: input.projectId, cause: input.cause, code: POOL_JOB_NO_PROMPT },
    `pm.spawn.refused: ${PM_NO_PROMPT_MESSAGE}`,
  );
  return { ok: false, reason: 'pool-job-no-prompt' };
}
