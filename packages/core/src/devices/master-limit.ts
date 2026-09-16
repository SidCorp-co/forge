/**
 * A master's own account limit, reported by the daemon that runs it.
 *
 * The job lane learns about a cap from a failed job's error text
 * (`finalize-failure` → `detectRunnerLimit`) and the chat lane from a terminal
 * report (`chat-runner-health`). A resident master is on neither: it produces
 * no job of its own and no chat session, so when its Claude account hits a cap
 * the fact reached nothing — `detect_usage_limit` has exactly one caller in the
 * runner, on the stream-json branch a master does not use.
 *
 * Both directions matter. The stamp is what makes the cap visible to the
 * dispatch gates and the operator; the clear is what ends the window early,
 * which is the whole point of the owner's 5-minute cadence — an account can be
 * swapped at any moment, so the parsed quota reset is a guess about a fact that
 * may already have changed.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerLimitReason, runners } from '../db/schema.js';
import { clearRunnerLimit, stampRunnerLimit } from '../runners/apply-runner-limit.js';
import { DEFAULT_LIMIT_COOLDOWN_MS } from '../runners/limit-detect.js';

export interface MasterLimitReport {
  reason: RunnerLimitReason;
  /** Seconds until the account is expected back; null when unknown or `auth`. */
  resetsInSeconds: number | null;
  detail: string;
}

/**
 * Any runner row of this device — the limit fans out device-wide from it.
 *
 * Deliberately unordered: `deviceScope` in `apply-runner-limit.ts` widens both
 * the stamp and the clear to every binding of the device, so which of a box's
 * rows comes back cannot change the outcome. It is only the handle.
 */
async function anyRunnerOfDevice(
  deviceId: string,
): Promise<{ id: string; projectId: string } | null> {
  const [row] = await db
    .select({ id: runners.id, projectId: runners.projectId })
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
    detail: report.detail,
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
