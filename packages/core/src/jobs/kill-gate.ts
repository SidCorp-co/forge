/**
 * ISS-785 — SSOT for the kill-before-reap gate.
 *
 * The loop-monitor's job-axis hops (ack / session-lost / result) used to flip
 * a non-progressing job straight to `failed` and schedule a retry from a pure
 * DB heuristic, with nothing ever telling the runner to stop. A false-positive
 * left the "dead" agent running — including git writes — in parallel with its
 * retry (ISS-37: a live agent reverted an already-merged commit while its
 * retry investigated). `job.cancel` (NOT `agent:abort` — that frame is
 * chat-only, keyed by `agent_sessions.id`; the runner keys pipeline jobs by
 * `jobId`) is the only frame that actually kills the process.
 *
 * `requestJobKill` stamps the request + publishes the kill exactly once per
 * job; `resolveKillConfirmation` decides whether it is now safe to treat the
 * job as genuinely dead (and therefore retryable) via any of: the runner's
 * own kill-ack, a terminal report that raced the request, or the owning
 * runner having gone stale (box unreachable — no channel exists to confirm
 * on, so its absence stands in for a positive answer).
 */

// cm:guard a reap MUST NOT flip a job to failed before requestJobKill + a confirmed resolveKillConfirmation — an unconfirmed kill that still retries spawns a second agent on the same worktree (ISS-785)
// cm:edge protocol -> packages/runner/crates/forge-runner-core/src/daemon/mod.rs — job.cancel is the ONLY frame that kills a pipeline job process (session key = jobId); agent:abort is chat-only

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

type JobRow = typeof jobs.$inferSelect;

/**
 * The minimal shape the gate needs — deliberately NOT the full `JobRow` so
 * loop-monitor's raw-SQL candidate rows (id + a handful of columns) can be
 * passed straight through without an extra round-trip to fetch the whole
 * row. A full `JobRow` structurally satisfies this too.
 */
export interface KillableJobRef {
  id: string;
  deviceId: string | null;
  runnerId: string | null;
  killRequestedAt: Date | null;
  killConfirmedAt: Date | null;
  killOutcome: JobRow['killOutcome'];
}

const KILL_CONFIRM_MS_DEFAULT = 90_000;
const KILL_CONFIRM_MS_FLOOR = 30_000;

/** `PIPELINE_KILL_CONFIRM_MS` — grace between requesting a kill and treating
 *  silence as unconfirmed. Floored so a low env override can't race the
 *  runner's own WS round-trip. */
export function killGraceMs(): number {
  const raw = process.env.PIPELINE_KILL_CONFIRM_MS;
  if (!raw) return KILL_CONFIRM_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= KILL_CONFIRM_MS_FLOOR ? n : KILL_CONFIRM_MS_DEFAULT;
}

export type RequestKillResult = 'requested' | 'no_device';

/**
 * Stamp `killRequestedAt` (idempotent — a second call for the same job is a
 * no-op) and publish `job.cancel` to the owning device room. Returns
 * `'no_device'` when the job has no `deviceId` — there is no channel to kill
 * over, so the caller must fall back to confirmation-by-absence once the
 * grace elapses.
 */
export async function requestJobKill(
  job: KillableJobRef,
  reason: string,
): Promise<RequestKillResult> {
  if (!job.killRequestedAt) {
    await db.update(jobs).set({ killRequestedAt: new Date() }).where(eq(jobs.id, job.id));
  }
  if (!job.deviceId) return 'no_device';
  roomManager.publish(deviceRoom(job.deviceId), {
    event: 'job.cancel',
    data: { jobId: job.id, reason },
  });
  return 'requested';
}

export interface KillConfirmation {
  confirmed: boolean;
  outcome: JobRow['killOutcome'];
}

/**
 * Resolve whether a job's kill request is now confirmed. Any one of:
 *   - the runner already answered (`killConfirmedAt`/`killOutcome` set by
 *     `POST /jobs/:id/kill-ack` or a terminal lifecycle report);
 *   - the owning runner's heartbeat is stale past `dispatchLivenessMs()` —
 *     the box is unreachable, so absence of an ack stands in for one.
 * Otherwise unconfirmed: the runner is online and heartbeating but silent
 * about the kill — the one state a reap must never treat as safe to retry.
 */
export async function resolveKillConfirmation(job: KillableJobRef): Promise<KillConfirmation> {
  if (job.killConfirmedAt) {
    return { confirmed: true, outcome: job.killOutcome };
  }
  if (!job.runnerId) {
    return { confirmed: false, outcome: null };
  }
  const [runner] = await db
    .select({ lastSeenAt: runners.lastSeenAt })
    .from(runners)
    .where(eq(runners.id, job.runnerId))
    .limit(1);
  const lastSeen = runner?.lastSeenAt ? new Date(runner.lastSeenAt).getTime() : null;
  if (lastSeen === null || Date.now() - lastSeen > dispatchLivenessMs()) {
    return { confirmed: true, outcome: 'runner_gone' };
  }
  return { confirmed: false, outcome: null };
}
