import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs, runners } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

type JobRow = typeof jobs.$inferSelect;

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

/** How long a kill request stays the CURRENT episode. Two grace windows: the
 *  gate resolves at one grace, so this tolerates a couple of skipped/failed
 *  loop ticks while still being far shorter than the gap between two reaps of
 *  the same long-lived job (the state that poisoned the gate pre-fix). */
export function killEpisodeWindowMs(): number {
  return killGraceMs() * 2;
}

/** Whether `job`'s kill columns describe an episode still in progress. False
 *  for a never-killed job AND for one whose request has aged out — in both
 *  cases the columns carry no answer about the process running right now. */
export function isKillEpisodeLive(job: KillableJobRef, now: number = Date.now()): boolean {
  if (!job.killRequestedAt) return false;
  return now - job.killRequestedAt.getTime() <= killEpisodeWindowMs();
}

export type RequestKillResult = 'requested' | 'no_device';

export async function requestJobKill(
  job: KillableJobRef,
  reason: string,
): Promise<RequestKillResult> {
  if (!isKillEpisodeLive(job)) {
    await db
      .update(jobs)
      .set({ killRequestedAt: new Date(), killConfirmedAt: null, killOutcome: null })
      .where(eq(jobs.id, job.id));
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

export async function resolveKillConfirmation(
  job: KillableJobRef,
  now: number = Date.now(),
): Promise<KillConfirmation> {
  if (
    job.killConfirmedAt &&
    job.killRequestedAt &&
    isKillEpisodeLive(job, now) &&
    job.killConfirmedAt.getTime() >= job.killRequestedAt.getTime()
  ) {
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
  if (lastSeen === null || now - lastSeen > dispatchLivenessMs()) {
    return { confirmed: true, outcome: 'runner_gone' };
  }
  return { confirmed: false, outcome: null };
}
