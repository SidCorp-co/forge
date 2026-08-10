import cronParser from 'cron-parser';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pmConfig } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { spawnPmSession } from './spawner.js';

const PM_CADENCE_QUEUE = 'pm.cadence.tick';
const PM_CADENCE_CRON = '* * * * *';
const CONFIG_REFRESH_MS = 5 * 60 * 1000;

let cachedAt = 0;
let cached: Array<{ projectId: string; cadenceCron: string }> = [];
let workerId: string | null = null;

async function loadConfigs(now: number) {
  if (now - cachedAt < CONFIG_REFRESH_MS && cached.length > 0) return cached;
  const rows = await db
    .select({ projectId: pmConfig.projectId, cadenceCron: pmConfig.cadenceCron })
    .from(pmConfig)
    .where(and(eq(pmConfig.enabled, true), isNotNull(pmConfig.cadenceCron)));
  cached = rows.filter((r): r is { projectId: string; cadenceCron: string } => !!r.cadenceCron);
  cachedAt = now;
  return cached;
}

/**
 * Run one cadence tick: for each `pm_config` with a cron expression, fire a
 * spawn if the expression's next-fire time falls inside the just-elapsed
 * minute window. The window is anchored to the minute boundary so a tick
 * that runs late still picks up the correct expressions.
 *
 * At-most-once per minute is reinforced by the spawner's per-project unique
 * index (`jobs_pm_per_project_unique_idx`); duplicate firings within the
 * same window resolve to `{ok:false, reason:'already-active'}` cleanly.
 */
export async function runPmCadenceTickOnce(now: Date = new Date()): Promise<string[]> {
  const cfgs = await loadConfigs(now.getTime());
  const fired: string[] = [];
  const windowEnd = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const windowStart = new Date(windowEnd.getTime() - 60_000);
  for (const c of cfgs) {
    try {
      const it = cronParser.parseExpression(c.cadenceCron, { currentDate: windowStart });
      const next = (it.next() as unknown as { toDate(): Date }).toDate();
      if (next > windowEnd) continue;
      const result = await spawnPmSession({ projectId: c.projectId, cause: 'tick' });
      if (result.ok) fired.push(c.projectId);
    } catch (err) {
      logger.warn(
        { err, projectId: c.projectId, cron: c.cadenceCron },
        'pm.cadence: bad cron',
      );
    }
  }
  return fired;
}

export async function registerPmCadenceTicker(): Promise<void> {
  if (workerId) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(PM_CADENCE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: see schedules/runner.ts
  const id = (await (boss as any).work(
    PM_CADENCE_QUEUE,
    { batchSize: 1 },
    async () => {
      try {
        const fired = await runPmCadenceTickOnce();
        if (fired.length > 0) logger.info({ projectIds: fired }, 'pm.cadence: fired');
      } catch (err) {
        logger.error({ err }, 'pm.cadence: tick threw');
        throw err;
      }
    },
  )) as string;
  workerId = id;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(PM_CADENCE_QUEUE, PM_CADENCE_CRON, {});
}

export async function unregisterPmCadenceTicker(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
    await (boss as any).unschedule(PM_CADENCE_QUEUE);
  } catch (err) {
    logger.warn({ err }, 'pm.cadence: unschedule failed');
  }
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).offWork(id);
}

export function _resetPmCadenceCacheForTest(): void {
  cachedAt = 0;
  cached = [];
}
