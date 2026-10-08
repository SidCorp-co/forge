// The one scheduler of core. A project's schedules rows and every timed job core runs for itself go
// through here: pg-boss holds exactly one cron, `schedule.tick`, and each tick claims the due rows
// and sends each due cluster timer to its own queue. A process timer runs on an interval inside this
// core, for work bound to what only this process holds (its chat sockets, its disk) or that must
// run faster than a minute.

import { CronExpressionParser } from 'cron-parser';
import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { boss } from '../queue/boss.js';
import { nextRunFor } from './cron.js';
import { dispatchScheduleRun } from './dispatch.js';

const TICK_QUEUE = 'schedule.tick';
const TICK_CRON = '* * * * *';

/** Once per due minute on one core of the cluster; `name` is its pg-boss queue. */
interface ClusterTimer {
  kind: 'cluster';
  name: string;
  /** Five-field cron, read in UTC. */
  cron: string;
  run: () => Promise<unknown>;
}

/** Every `everyMs` on this core; a tick still running when the next is due is not overlapped. */
interface ProcessTimer {
  kind: 'process';
  name: string;
  everyMs: number;
  /** Run once as soon as the timer starts instead of waiting a whole interval. */
  runAtStart?: boolean;
  run: () => Promise<unknown>;
}

export type Timer = ClusterTimer | ProcessTimer;

let clusterTimers: readonly ClusterTimer[] = [];
const workers: { name: string; id: string }[] = [];
const processStops: Array<() => void> = [];
let started = false;

function minuteOf(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

function isDueAt(cron: string, now: Date): boolean {
  const minute = minuteOf(now);
  const next = CronExpressionParser.parse(cron, {
    currentDate: new Date(minute.getTime() - 1),
    tz: 'UTC',
  }).next() as unknown as { toDate(): Date };
  return next.toDate().getTime() === minute.getTime();
}

function assertTimers(timers: readonly Timer[]): void {
  const seen = new Set<string>([TICK_QUEUE]);
  for (const t of timers) {
    if (seen.has(t.name)) throw new Error(`timers: "${t.name}" is declared twice`);
    seen.add(t.name);
    if (t.kind === 'cluster') {
      try {
        CronExpressionParser.parse(t.cron, { tz: 'UTC' });
      } catch {
        throw new Error(`timers: "${t.name}" has an invalid cron "${t.cron}"`);
      }
    } else if (!Number.isFinite(t.everyMs) || t.everyMs <= 0) {
      throw new Error(`timers: "${t.name}" needs a positive everyMs, got ${t.everyMs}`);
    }
  }
}

/** Claim each enabled schedule whose nextRunAt has come, and fire it. */
async function runScheduleTickOnce(now: Date = new Date()): Promise<string[]> {
  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)));

  const dispatched: string[] = [];
  for (const schedule of due) {
    try {
      // Atomic claim: only one ticker wins for this (id, nextRunAt) pair.
      const claimed = await db
        .update(schedules)
        .set({ nextRunAt: nextRunFor(schedule.cron, now, schedule.timeZone) })
        .where(
          and(
            eq(schedules.id, schedule.id),
            eq(schedules.enabled, true),
            schedule.nextRunAt
              ? eq(schedules.nextRunAt, schedule.nextRunAt)
              : sql`${schedules.nextRunAt} IS NULL`,
          ),
        )
        .returning({ id: schedules.id });
      if (claimed.length === 0) continue; // another ticker won the race

      const result = await dispatchScheduleRun({
        schedule: {
          id: schedule.id,
          name: schedule.name,
          projectId: schedule.projectId,
          prompt: schedule.prompt,
          targetProjectSlug: schedule.targetProjectSlug ?? null,
          params: (schedule.params as Record<string, unknown> | null) ?? null,
          kind: schedule.kind,
          script: schedule.script ?? null,
          ownerId: schedule.ownerId,
          cron: schedule.cron,
          timeZone: schedule.timeZone,
        },
        tick: true,
      });

      if (result.ok) dispatched.push(schedule.id);
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'schedule.tick: dispatch failed');
    }
  }
  return dispatched;
}

/** Send every cluster timer due this minute; a second tick in the same minute sends nothing. */
async function sendDueTimers(now: Date = new Date()): Promise<string[]> {
  const sent: string[] = [];
  for (const t of clusterTimers) {
    if (!isDueAt(t.cron, now)) continue;
    const id = await boss.send(t.name, {}, { singletonKey: t.name, singletonSeconds: 60 });
    if (id) sent.push(t.name);
  }
  return sent;
}

async function tick(): Promise<void> {
  const now = new Date();
  const [rows, timers] = await Promise.allSettled([runScheduleTickOnce(now), sendDueTimers(now)]);
  if (rows.status === 'fulfilled' && rows.value.length > 0) {
    logger.info({ scheduleIds: rows.value }, 'schedule.tick: dispatched');
  }
  const failed = [rows, timers].find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

function startProcessTimer(t: ProcessTimer): () => void {
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void t
      .run()
      .catch((err) => logger.error({ err, timer: t.name }, 'timers: a process tick failed'))
      .finally(() => {
        running = false;
      });
  };
  const handle = setInterval(run, t.everyMs);
  handle.unref?.();
  if (t.runAtStart) run();
  return () => clearInterval(handle);
}

// pg-boss keeps a schedule row until it is unscheduled, so a cron any earlier build registered
// would go on firing beside the tick. Every schedule but the tick is removed, by name.
async function removeOtherCrons(): Promise<void> {
  for (const s of await boss.getSchedules()) {
    if (s.name === TICK_QUEUE) continue;
    await boss.unschedule(s.name);
    logger.warn({ queue: s.name, cron: s.cron }, 'timers: removed a pg-boss cron beside the tick');
  }
}

export async function startTimers(timers: readonly Timer[]): Promise<void> {
  if (started) return;
  assertTimers(timers);
  started = true;
  clusterTimers = timers.filter((t): t is ClusterTimer => t.kind === 'cluster');

  for (const t of clusterTimers) {
    await boss.createQueue(t.name);
    workers.push({
      name: t.name,
      id: await boss.work(t.name, async () => {
        try {
          await t.run();
        } catch (err) {
          logger.error({ err, timer: t.name }, 'timers: a cluster tick failed');
          throw err;
        }
      }),
    });
  }

  await boss.createQueue(TICK_QUEUE);
  workers.push({ name: TICK_QUEUE, id: await boss.work(TICK_QUEUE, { batchSize: 1 }, tick) });
  await removeOtherCrons();
  await boss.schedule(TICK_QUEUE, TICK_CRON, {}, { tz: 'UTC' });

  for (const t of timers) if (t.kind === 'process') processStops.push(startProcessTimer(t));
}

export async function stopTimers(): Promise<void> {
  if (!started) return;
  started = false;
  for (const stop of processStops.splice(0)) stop();
  for (const { name, id } of workers.splice(0)) {
    await boss.offWork(name, { id }).catch((err) => logger.warn({ err }, 'timers: offWork failed'));
  }
  clusterTimers = [];
}
