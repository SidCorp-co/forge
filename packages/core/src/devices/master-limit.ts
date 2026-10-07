import {
  MASTER_LIMIT_FRESH_SECONDS,
  MASTER_NUDGE_REFRESH_SECONDS,
  type MasterLimitOutcome,
  type MasterLimitRecord,
} from '@forge/contracts/master-verdict';
import { scrubSecretsDeep } from '@forge/observability';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerLimitReason, runners } from '../db/schema.js';
import { clearRunnerLimit, DEFAULT_LIMIT_COOLDOWN_MS, stampRunnerLimit } from '../runners/index.js';

interface MasterLimitReport {
  reason: RunnerLimitReason;
  /** Seconds until the account is expected back; null when unknown or `auth`. */
  resetsInSeconds: number | null;
  detail: string;
}

interface DeviceRunner {
  id: string;
  projectId: string;
  limitReason: RunnerLimitReason | null;
  limitDetail: string | null;
  rateLimitedUntil: Date | null;
}

async function anyRunnerOfDevice(deviceId: string): Promise<DeviceRunner | null> {
  const [row] = await db
    .select({
      id: runners.id,
      projectId: runners.projectId,
      limitReason: runners.limitReason,
      limitDetail: runners.limitDetail,
      rateLimitedUntil: runners.rateLimitedUntil,
    })
    .from(runners)
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')))
    .limit(1);
  return row ?? null;
}

/**
 * Stamp the reported limit on every binding of this device. Returns `null`
 * when the device owns no `claude-code` runner, which the route refuses by
 * name rather than answering 200 to a report nothing recorded.
 */
export async function recordMasterLimit(
  deviceId: string,
  report: MasterLimitReport,
): Promise<{ runnerId: string } | null> {
  const runner = await anyRunnerOfDevice(deviceId);
  if (!runner) return null;
  const until =
    report.reason === 'auth'
      ? null
      : new Date(
          Date.now() +
            (report.resetsInSeconds === null
              ? DEFAULT_LIMIT_COOLDOWN_MS
              : report.resetsInSeconds * 1000),
        );
  await stampRunnerLimit(runner.id, runner.projectId, {
    reason: report.reason,
    until,
    detail: scrubSecretsDeep(report.detail),
  });
  return { runnerId: runner.id };
}

/**
 * Lift the limit on every binding of this device — the master's next
 * successful turn is proof its account works again.
 */
export async function clearMasterLimit(deviceId: string): Promise<{ runnerId: string } | null> {
  const runner = await anyRunnerOfDevice(deviceId);
  if (!runner) return null;
  await clearRunnerLimit(runner.id, runner.projectId);
  return { runnerId: runner.id };
}

export type MasterLimitAction =
  | { act: 'report'; report: MasterLimitReport }
  | { act: 'clear' }
  | { act: 'none'; outcome: 'held' | 'stale' | 'nothing' | 'unreadable' };

/**
 * What a box's newest decisive record means for its account, given what core already holds for the
 * device. A refusal speaks for the account only while it is fresh either way, and once: one core
 * already holds is left as it is rather than stamped again. A turn the account answered lifts a limit
 * only within one nudge refresh of that turn, since it is the only proof a window ended.
 */
export function masterLimitAction(
  record: MasterLimitRecord,
  held: Pick<DeviceRunner, 'limitReason' | 'limitDetail' | 'rateLimitedUntil'>,
  now: Date,
): MasterLimitAction {
  switch (record.kind) {
    case 'unreadable':
      return { act: 'none', outcome: 'unreadable' };
    case 'refused': {
      if (Math.abs(record.agoSeconds) > MASTER_LIMIT_FRESH_SECONDS) {
        return { act: 'none', outcome: 'stale' };
      }
      const stillHeld =
        held.limitReason === record.reason &&
        held.limitDetail === scrubSecretsDeep(record.detail) &&
        (record.reason === 'auth' ||
          (held.rateLimitedUntil !== null && held.rateLimitedUntil > now));
      if (stillHeld) return { act: 'none', outcome: 'held' };
      return {
        act: 'report',
        report: {
          reason: record.reason,
          resetsInSeconds: record.reason === 'auth' ? null : record.resetsInSeconds,
          detail: record.detail,
        },
      };
    }
    case 'worked':
      return held.limitReason !== null &&
        record.agoSeconds >= 0 &&
        record.agoSeconds <= MASTER_NUDGE_REFRESH_SECONDS
        ? { act: 'clear' }
        : { act: 'none', outcome: 'nothing' };
  }
}

/**
 * Decide and apply what a box's newest decisive record says about its account. Returns `null` when
 * the device owns no `claude-code` runner, which the route refuses by name.
 */
export async function judgeMasterLimit(
  deviceId: string,
  record: MasterLimitRecord,
): Promise<{ runnerId: string; outcome: MasterLimitOutcome } | null> {
  const runner = await anyRunnerOfDevice(deviceId);
  if (!runner) return null;
  const action = masterLimitAction(record, runner, new Date());
  if (action.act === 'report') {
    await recordMasterLimit(deviceId, action.report);
    return { runnerId: runner.id, outcome: 'reported' };
  }
  if (action.act === 'clear') {
    await clearMasterLimit(deviceId);
    return { runnerId: runner.id, outcome: 'cleared' };
  }
  return { runnerId: runner.id, outcome: action.outcome };
}
