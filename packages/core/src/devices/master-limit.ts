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
import { clearRunnerLimit, type RunnerLimit, stampRunnerLimit } from '../runners/index.js';

interface MasterLimitReport {
  reason: RunnerLimitReason;
  /** When the account refused, by the record's own age. */
  refusedAt: Date;
  /** Seconds until the reset the account printed; null when it printed none, or for `auth`. */
  resetsInSeconds: number | null;
  detail: string;
}

interface DeviceRunner {
  id: string;
  projectId: string;
  limitReason: RunnerLimitReason | null;
  limitRefusedAt: Date | null;
}

async function anyRunnerOfDevice(deviceId: string): Promise<DeviceRunner | null> {
  const [row] = await db
    .select({
      id: runners.id,
      projectId: runners.projectId,
      limitReason: runners.limitReason,
      limitRefusedAt: runners.limitRefusedAt,
    })
    .from(runners)
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')))
    .limit(1);
  return row ?? null;
}

const REFRESH_MS = MASTER_NUDGE_REFRESH_SECONDS * 1000;

/**
 * What a master's refusal holds (ISS-276, FB-87: the account printed 19:30Z and answered at 16:42Z).
 * The next try is the next nudge, which a limited master is asked again on; the reset the account
 * printed is kept as its claim. A refusal the box's clock dates ahead is dated now.
 */
export function masterRefusalLimit(report: MasterLimitReport, now: Date): RunnerLimit {
  const refusedAt = report.refusedAt > now ? now : report.refusedAt;
  const auth = report.reason === 'auth';
  return {
    reason: report.reason,
    refusedAt,
    nextTryAt: auth ? null : new Date(refusedAt.getTime() + REFRESH_MS),
    printedResetAt:
      auth || report.resetsInSeconds === null
        ? null
        : new Date(now.getTime() + report.resetsInSeconds * 1000),
    detail: scrubSecretsDeep(report.detail),
  };
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
  await stampRunnerLimit(runner.id, runner.projectId, masterRefusalLimit(report, new Date()));
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

type MasterLimitAction =
  | { act: 'report'; report: MasterLimitReport }
  | { act: 'clear' }
  | { act: 'none'; outcome: 'held' | 'stale' | 'nothing' | 'unreadable' };

/** Two refusals this close are the same one, read twice off the box's clock. */
const SAME_REFUSAL_MS = 60_000;

/**
 * What a box's newest decisive record means for its account, given what core already holds for the
 * device. A refusal speaks for the account until its next try has come, and once: one core already
 * holds (or a newer one) is left as it is rather than stamped again, so an old record neither
 * restarts nor extends a hold. A turn the account answered lifts a limit only within one nudge
 * refresh of that turn, since it is the only proof a window ended.
 */
export function masterLimitAction(
  record: MasterLimitRecord,
  held: Pick<DeviceRunner, 'limitReason' | 'limitRefusedAt'>,
  now: Date,
): MasterLimitAction {
  switch (record.kind) {
    case 'unreadable':
      return { act: 'none', outcome: 'unreadable' };
    case 'refused': {
      if (Math.abs(record.agoSeconds) > MASTER_LIMIT_FRESH_SECONDS) {
        return { act: 'none', outcome: 'stale' };
      }
      const refusedAt = new Date(now.getTime() - record.agoSeconds * 1000);
      const stillHeld =
        held.limitReason === record.reason &&
        held.limitRefusedAt !== null &&
        held.limitRefusedAt.getTime() >= refusedAt.getTime() - SAME_REFUSAL_MS;
      if (stillHeld) return { act: 'none', outcome: 'held' };
      if (record.reason !== 'auth' && record.agoSeconds * 1000 >= REFRESH_MS) {
        return { act: 'none', outcome: 'stale' };
      }
      return {
        act: 'report',
        report: {
          reason: record.reason,
          refusedAt,
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
