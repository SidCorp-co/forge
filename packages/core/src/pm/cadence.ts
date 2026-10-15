import { CronExpressionParser } from 'cron-parser';
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

export async function runPmCadenceTickOnce(now: Date = new Date()): Promise<string[]> {
  const cfgs = await loadConfigs(now.getTime());
  const fired: string[] = [];
  const windowEnd = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const windowStart = new Date(windowEnd.getTime() - 60_000);
  for (const c of cfgs) {
    try {
      const it = CronExpressionParser.parse(c.cadenceCron, { currentDate: windowStart });
      const next = (it.next() as unknown as { toDate(): Date }).toDate();
      if (next > windowEnd) continue;
      const result = await spawnPmSession({ projectId: c.projectId, cause: 'tick' });
      if (result.ok) fired.push(c.projectId);
    } catch (err) {
      logger.warn({ err, projectId: c.projectId, cron: c.cadenceCron }, 'pm.cadence: bad cron');
    }
  }
  return fired;
}

export async function registerPmCadenceTicker(): Promise<void> {
  if (workerId) return;
  await boss.createQueue(PM_CADENCE_QUEUE);
  const id = await boss.work(PM_CADENCE_QUEUE, { batchSize: 1 }, async () => {
    try {
      const fired = await runPmCadenceTickOnce();
      if (fired.length > 0) logger.info({ projectIds: fired }, 'pm.cadence: fired');
    } catch (err) {
      logger.error({ err }, 'pm.cadence: tick threw');
      throw err;
    }
  });
  workerId = id;
  await boss.schedule(PM_CADENCE_QUEUE, PM_CADENCE_CRON, {});
}

export async function unregisterPmCadenceTicker(): Promise<void> {
  if (!workerId) return;
  const id = workerId;
  workerId = null;
  try {
    await boss.unschedule(PM_CADENCE_QUEUE);
  } catch (err) {
    logger.warn({ err }, 'pm.cadence: unschedule failed');
  }
  // Passing options replaces pg-boss's default `{ wait: true }`, so it is named: without it this
  // returns while a fetch in flight still holds the worker.
  await boss.offWork(PM_CADENCE_QUEUE, { id, wait: true });
}

export function _resetPmCadenceCacheForTest(): void {
  cachedAt = 0;
  cached = [];
}
