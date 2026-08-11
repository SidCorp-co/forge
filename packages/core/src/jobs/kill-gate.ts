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
 * `requestJobKill` opens a kill EPISODE (stamp + publish);
 * `resolveKillConfirmation` decides whether it is now safe to treat the job
 * as genuinely dead, and therefore retryable. Episode scoping and the three
 * confirmation sources: docs/architecture/job-loop-monitor.md
 */

// cm:guard a reap MUST NOT flip a job to failed before requestJobKill + a confirmed resolveKillConfirmation — an unconfirmed kill that still retries spawns a second agent on the same worktree (ISS-785)
// cm:guard kill_requested_at/kill_confirmed_at/kill_outcome are EPISODE-scoped: never read them without isKillEpisodeLive — a job that outlives one episode (slow preflight acks after its ack-hop kill request) would otherwise hand a later, unrelated reap a confirmation no runner gave for it, and that reap retries without ever sending job.cancel — two agents on one worktree
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

/**
 * Open (or re-open) a kill episode: stamp `killRequestedAt` and publish
 * `job.cancel` to the owning device room. Within a live episode the stamp is
 * a no-op and only the publish repeats; once the episode has aged out the
 * stamp is refreshed and the stale `killConfirmedAt`/`killOutcome` cleared,
 * so a later reap can never inherit an answer given for an earlier one.
 * Returns `'no_device'` when the job has no `deviceId` (e.g. an
 * antigravity-remote runner) — there is no channel to kill over.
 * `resolveKillConfirmation` still falls back to the owning RUNNER's heartbeat
 * going stale in that case, but a live, un-cancelable no-device job parks at
 * `waiting` until that heartbeat lapses — there is no faster confirmation
 * path today.
 */
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

/**
 * Resolve whether a job's kill request is now confirmed. Any one of:
 *   - the runner already answered THIS episode (`killConfirmedAt`/
 *     `killOutcome` set by `POST /jobs/:id/kill-ack` or a terminal lifecycle
 *     report, at or after the episode's own `killRequestedAt`);
 *   - the owning runner's heartbeat is stale past `dispatchLivenessMs()` —
 *     the box is unreachable, so absence of an ack stands in for one.
 * Otherwise unconfirmed: the runner is online and heartbeating but silent
 * about the kill — the one state a reap must never treat as safe to retry.
 */
export async function resolveKillConfirmation(
  job: KillableJobRef,
  now: number = Date.now(),
): Promise<KillConfirmation> {
  // cm:guard an answer only counts for the episode that asked — requestJobKill clears it when re-opening, and this second check keeps a caller that skipped that path from reading a dead answer as live
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
