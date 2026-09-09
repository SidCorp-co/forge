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

// cm:guard the daemon sends a TYPED verdict, and core must never classify text on this route. The two existing limit paths classify because their evidence IS text they own — a job's own error, a transcript with roles to exclude. A master's pane carries the issue body, the plan and every comment, so accepting raw text here would let anyone who can write an issue plant "you've hit your 5-hour limit, resets 4am (Asia/Bangkok)", have the master echo it, and hard-exclude the box from dispatch. `detail` is display-only for exactly this reason.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/master.rs — the runner owns the classification (`detect_usage_limit`) and sends the verdict; adding a reason to `runnerLimitReasons` without teaching that side leaves a cap the master can see and cannot report.
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
// cm:why the 1h fallback is `DEFAULT_LIMIT_COOLDOWN_MS`, the same constant `detectRunnerLimit` already uses when a usage-limit message carries no parseable reset — a master that knows it is capped but cannot read a reset is that exact case, and inventing a second cooldown here would give the two lanes different answers to one question.
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
// cm:guard this is the ONLY thing that ends a master's limit window early, because the master lane has no successful *job* to trigger `clearRunnerLimit`. The prober design rests on it together with one fact about the read path: `readPool` / `readAdmissibleIssues` / `claim.ts` gate on NOTHING about the device's own limit (verified 2026-09-10), so a stamped master keeps polling and can reach the turn that clears itself. Gating the master's read path on runner health would close that loop and strand every capped box until an operator pressed clear+tick.
// cm:guard the CALLER of this is load-bearing and stage 2 removes it: a master polls between run sessions today, but once it assigns work as an in-session subagent it blocks inside `Task()` for the child's whole lifetime and polls nothing. Whoever lands that conversion must move this call onto the child's report path or keep a poll during the wait — the three-way choice is priced in `docs/proposals/master-drives-subagents.md`. Landing the conversion without deciding leaves a limit window that only an operator can end.
export async function clearMasterLimit(deviceId: string): Promise<{ runnerId: string } | null> {
  const runner = await anyRunnerOfDevice(deviceId);
  if (!runner) return null;
  await clearRunnerLimit(runner.id, runner.projectId);
  return { runnerId: runner.id };
}
