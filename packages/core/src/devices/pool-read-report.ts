/**
 * What a box says about its own reads of each project's job pool (ISS-1234).
 *
 * A pool read that fails at the gateway (520, 522, 525) never reaches core, so
 * core cannot see the fault from its side. The box that received it reports it
 * on the heartbeat, a different route that answered normally around every
 * measured failure. The verdict stays the box's: forge-runner's pool-read record
 * holds the one definition of blind and intermittent, and this module only reads it.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { WIRE_UNITS } from './gate-report.js';

export const poolReadVerdicts = ['blind', 'intermittent'] as const;
export type PoolReadVerdict = (typeof poolReadVerdicts)[number];

/**
 * Both sides read this from `pool-read-report.fixture.json`. The box never truncates
 * to it, since an omitted project is cleared: past it the whole report is refused.
 */
export const WIRE_PROJECTS = 256;

const failureSchema = z
  .object({
    at: z.number().int().nonnegative(),
    status: z.number().int().min(100).max(599).nullable(),
    what: z.string().max(WIRE_UNITS),
    reason: z.string().max(WIRE_UNITS),
  })
  .strict();

const conditionSchema = z
  .object({
    projectId: z.uuid(),
    verdict: z.enum(poolReadVerdicts),
    failures: z.number().int().positive(),
    countIsFloor: z.boolean(),
    windowMs: z.number().int().positive(),
    unreadSince: z.number().int().nonnegative().nullable(),
    consecutive: z.number().int().nonnegative(),
    recoveredAt: z.number().int().nonnegative().nullable(),
    lastFailure: failureSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    const blind = c.verdict === 'blind';
    if (blind !== (c.unreadSince !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unreadSince'],
        message: blind
          ? 'a blind project names when its run of failed reads began'
          : 'only a blind project has an unreadSince',
      });
    }
    if (blind ? c.consecutive < 1 : c.consecutive !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['consecutive'],
        message: blind
          ? 'a blind project has at least one consecutive failed read'
          : 'only a blind project has consecutive failed reads',
      });
    }
    if (blind && c.recoveredAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['recoveredAt'],
        message: 'a blind project has not recovered',
      });
    }
  });

export const poolReportSchema = z
  .object({ projects: z.array(conditionSchema).max(WIRE_PROJECTS) })
  .strict();

export type PoolReport = z.infer<typeof poolReportSchema>;
export type PoolCondition = z.infer<typeof conditionSchema>;

/** What every surface shows for one runner; `null` where its box reported no failed read. */
export type RunnerPoolRead = PoolCondition & { receivedAt: string };

export function readHeartbeatPool(pool: unknown): { report?: PoolReport; refused?: string } {
  if (pool === undefined) return {};
  const parsed = poolReportSchema.safeParse(pool);
  if (parsed.success) return { report: parsed.data };
  const first = parsed.error.issues[0];
  const at = first?.path.length ? `pool.${first.path.join('.')}` : 'pool';
  return { refused: `${at}: ${first?.message ?? 'not a pool report core can read'}` };
}

/**
 * The list is the box's whole picture, so a runner of this device whose project
 * it omits read cleanly all window and is cleared; one statement, so no runner is
 * read half-updated.
 */
async function storePoolReport(deviceId: string, report: PoolReport, now: Date): Promise<void> {
  const stamped = report.projects.map((p) => ({ ...p, receivedAt: now.toISOString() }));
  await db.execute(sql`
    UPDATE runners
    SET pool_read = (
      SELECT e.value FROM jsonb_array_elements(${JSON.stringify(stamped)}::jsonb) AS e
      WHERE e.value->>'projectId' = runners.project_id::text
      LIMIT 1
    )
    WHERE device_id = ${deviceId}
  `);
}

/**
 * Liveness is the heartbeat's kernel job and the pool report rides along, so a
 * field core cannot read, or cannot store, is refused by name in the response and
 * never costs the box its heartbeat. No `pool` key changes nothing.
 */
export async function heartbeatPool(
  pool: unknown,
  deviceId: string,
  now: Date = new Date(),
): Promise<{ ack: Record<string, unknown> }> {
  if (pool === undefined) return { ack: {} };
  const read = readHeartbeatPool(pool);
  if (read.refused || !read.report) {
    logger.warn(
      { deviceId, reason: read.refused },
      'heartbeat: this box sent a pool report core cannot read, so nothing was stored',
    );
    return { ack: { pool: { accepted: false, reason: read.refused } } };
  }
  try {
    await storePoolReport(deviceId, read.report, now);
  } catch (err) {
    logger.error({ deviceId, err }, 'heartbeat: a readable pool report could not be stored');
    return { ack: { pool: { accepted: false, reason: 'core could not store the pool report' } } };
  }
  return { ack: { pool: { accepted: true } } };
}

export function readRunnerPoolRead(stored: unknown): RunnerPoolRead | null {
  if (stored === null || typeof stored !== 'object') return null;
  const { receivedAt, ...condition } = stored as { receivedAt?: unknown };
  const parsed = conditionSchema.safeParse(condition);
  if (!parsed.success) return null;
  return { ...parsed.data, receivedAt: typeof receivedAt === 'string' ? receivedAt : '' };
}
