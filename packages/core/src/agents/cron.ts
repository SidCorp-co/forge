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
  await boss.createQueue(AGENT_CRON_QUEUE);
  const id = await boss.work(AGENT_CRON_QUEUE, { batchSize: 1 }, async () => {
    try {
      const fired = await runAgentCronTickOnce();
      if (fired.length > 0) logger.info({ agentIds: fired }, 'agent.cron: fired');
    } catch (err) {
      logger.error({ err }, 'agent.cron: tick threw');
      throw err;
    }
  });
  workerId = id;
  await boss.schedule(AGENT_CRON_QUEUE, AGENT_CRON_CRON, {});
}

export async function unregisterAgentCronTicker(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  try {
    await boss.unschedule(AGENT_CRON_QUEUE);
  } catch (err) {
    logger.warn({ err }, 'agent.cron: unschedule failed');
  }
  // Passing options replaces pg-boss's default `{ wait: true }`, so it is named: without it this
  // returns while a fetch in flight still holds the worker.
  await boss.offWork(AGENT_CRON_QUEUE, { id, wait: true });
}
