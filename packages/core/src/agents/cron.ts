import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { logger } from '../logger.js';
import { spawnPmSession } from '../pm/spawner.js';
import { boss } from '../queue/boss.js';
import { shouldRunToday } from './should-run-today.js';

const AGENT_CRON_QUEUE = 'agent.cron.tick';
const AGENT_CRON_CRON = '0 0 * * *';

let workerId: string | null = null;

/**
 * Daily tick: scan agents with `enabled=true AND schedule != 'off'` and, for
 * each whose schedule fires today, enqueue a PM session via the canonical
 * spawner. Per-project dedup is enforced by `jobs_pm_per_project_unique_idx`,
 * so a second tick on the same day resolves cleanly to `already-active`.
 *
 * Scope note: `agents.type` is open-ended `text` (no enum). Today PM is the
 * canonical cron entry-point for every agent that opts in via `schedule`, so
 * we don't filter on `type`. If a future agent type needs different cron
 * behaviour (e.g. its own queue), branch on `row.type` here instead of
 * unconditionally calling `spawnPmSession`.
 */
export async function runAgentCronTickOnce(now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({
      id: agents.id,
      projectId: agents.projectId,
      type: agents.type,
      schedule: agents.schedule,
    })
    .from(agents)
    .where(and(eq(agents.enabled, true), ne(agents.schedule, 'off')));

  const fired: string[] = [];
  for (const row of rows) {
    if (!shouldRunToday(row.schedule, now)) continue;
    try {
      const result = await spawnPmSession({
        projectId: row.projectId,
        cause: 'agent-cron',
        eventRef: { agentId: row.id, agentType: row.type, schedule: row.schedule },
      });
      if (result.ok) {
        fired.push(row.id);
      } else {
        // Surface skipped/rate-limited spawns at info level so operators can
        // diagnose missing daily runs (e.g. project hit `maxRunsPerHour` from
        // unrelated triggers and silently dropped today's agent-cron tick).
        logger.info(
          { agentId: row.id, projectId: row.projectId, reason: result.reason },
          'agent.cron: spawn skipped',
        );
      }
    } catch (err) {
      logger.error({ err, agentId: row.id }, 'agent.cron: spawn threw');
    }
  }
  return fired;
}

export async function registerAgentCronTicker(): Promise<void> {
  if (workerId) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(AGENT_CRON_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: see schedules/runner.ts
  const id = (await (boss as any).work(
    AGENT_CRON_QUEUE,
    { batchSize: 1 },
    async () => {
      try {
        const fired = await runAgentCronTickOnce();
        if (fired.length > 0) logger.info({ agentIds: fired }, 'agent.cron: fired');
      } catch (err) {
        logger.error({ err }, 'agent.cron: tick threw');
        throw err;
      }
    },
  )) as string;
  workerId = id;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(AGENT_CRON_QUEUE, AGENT_CRON_CRON, {});
}

export async function unregisterAgentCronTicker(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).unschedule(AGENT_CRON_QUEUE);
  } catch (err) {
    logger.warn({ err }, 'agent.cron: unschedule failed');
  }
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).offWork(id);
}
