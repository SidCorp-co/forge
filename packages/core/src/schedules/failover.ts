/**
 * ISS-584 (B) — schedule cross-runner failover, split out of `dispatch.ts`
 * (ISS-875) where it had grown past the file budget beside the unrelated
 * dispatch path. Async and sweeper-driven, mirroring the pipeline job
 * reaper→retry model.
 *
 * Re-exported from `./dispatch.js` because `jobs/loop-monitor.ts` reaches this
 * function through a dynamic `import('../schedules/dispatch.js')`.
 */

import { eq } from 'drizzle-orm';
import { createChatSessionRow, dispatchChatTurn } from '../agent-sessions/chat-turn.js';
import { db } from '../db/client.js';
import { agentSessions, projects, schedules } from '../db/schema.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';

// cm:why 2 failovers means 3 devices tried in total, counting the one the run was first dispatched to
const MAX_SCHEDULE_FAILOVERS = 2;

interface ScheduleFailoverState {
  attempt: number;
  triedDeviceIds: string[];
}

export type ScheduleFailoverResult =
  | { ok: true; status: 'redispatched'; sessionId: string; deviceId: string }
  | {
      ok: false;
      status: 'not-schedule' | 'exhausted' | 'no-device' | 'no-prompt' | 'side-effects' | 'error';
    };

// cm:why the disposition is written as a sentence rather than a token because it lands in `failure_detail`, whose contract (ISS-877) is prose — the token column `failure_reason` keeps the classifier's cause and is never touched here
const FAILOVER_DISPOSITIONS: Record<
  Exclude<ScheduleFailoverResult['status'], 'redispatched'>,
  string
> = {
  'side-effects': 'no failover (session had attached and run tool calls; side effects preserved)',
  'no-device': 'no failover (no other device was available)',
  exhausted: `no failover (chain exhausted after ${MAX_SCHEDULE_FAILOVERS} re-dispatches)`,
  'no-prompt': 'no failover (the failed session carries no prompt to re-run)',
  'not-schedule': 'no failover (not a schedule run)',
  error: 'no failover (the failover attempt threw)',
};

/**
 * ISS-875 — replace the disposition the classifier PREDICTED on the failed row
 * with the one this attempt actually applied.
 *
 * `finalizeScheduleSessionFailure` stamps `failure_detail` before the failover
 * runs, so the row reads `usage/session limit → cross-device failover` whatever
 * happens next; the outcome was previously only logged. Callers that never made
 * such a claim (the loop-monitor sweep, whose sessions carry the bare
 * `no_client_ack` token) pass no `failureClass` and are left alone — there is
 * nothing to correct.
 */
async function stampFailoverDisposition(
  sessionId: string,
  result: ScheduleFailoverResult,
  failureClass: string | null,
): Promise<void> {
  if (!failureClass) return;
  const disposition = result.ok
    ? `cross-device failover (re-dispatched to device ${result.deviceId})`
    : FAILOVER_DISPOSITIONS[result.status];
  try {
    await db
      .update(agentSessions)
      .set({ failureDetail: `${failureClass} → ${disposition}` })
      .where(eq(agentSessions.id, sessionId));
  } catch (err) {
    logger.error(
      { err, sessionId, status: result.status },
      'schedule.failover: disposition write-back threw',
    );
  }
}

/**
 * ISS-875 — a schedule run that died after committing work is abandoned here,
 * and the next cron firing does NOT recover a window-scoped schedule (see the
 * guard on `redispatchScheduleSessionOnFailover`), so the operator is the only
 * remaining recovery path. Best-effort: a delivery failure must not turn the
 * refusal to re-dispatch into a thrown failover.
 */
async function alertAbandonedScheduleWork(row: {
  id: string;
  projectId: string;
  userId: string | null;
  title: string | null;
  scheduleId: string;
}): Promise<void> {
  if (!row.userId) return;
  try {
    await emitNotification({
      userId: row.userId,
      projectId: row.projectId,
      type: 'schedule_report',
      severity: 'warning',
      agentSessionId: row.id,
      title: `Scheduled run failed mid-flight: ${row.title ?? 'Scheduled run'}`,
      body: 'The run had already started work when it died, so it was not re-dispatched (re-running it would repeat whatever it committed). Its window is not covered by the next firing — re-run it by hand if the work still matters.',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: row.id, scheduleId: row.scheduleId },
      'schedule.failover: abandoned-work alert delivery threw',
    );
  }
}

/**
 * Re-dispatch a failed schedule session onto another runner. Idempotent-safe:
 * it reads the prompt already materialized on the failed session (no prompt
 * re-build) and creates a fresh `system` session for the retry, carrying an
 * incremented failover chain in metadata. Returns a discriminated result, and
 * writes the disposition it settled on back onto the failed row when the caller
 * names the failure class the classifier already published there.
 */
export async function redispatchScheduleSessionOnFailover(
  sessionId: string,
  opts?: { failureClass?: string | null },
): Promise<ScheduleFailoverResult> {
  const result = await attemptScheduleFailover(sessionId);
  await stampFailoverDisposition(sessionId, result, opts?.failureClass ?? null);
  return result;
}

async function attemptScheduleFailover(sessionId: string): Promise<ScheduleFailoverResult> {
  const [failed] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      userId: agentSessions.userId,
      deviceId: agentSessions.deviceId,
      title: agentSessions.title,
      messages: agentSessions.messages,
      metadata: agentSessions.metadata,
      claudeSessionId: agentSessions.claudeSessionId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!failed) return { ok: false, status: 'error' };

  const meta = (failed.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'schedule.run' || typeof meta.scheduleId !== 'string') {
    return { ok: false, status: 'not-schedule' };
  }

  // cm:guard NEVER re-dispatch a session that may have committed work: re-running replays every side effect it already landed. Attached (`claudeSessionId` non-null) with anything other than a PROVEN `toolCallCount: 0` counts as may-have — `/desktop/status` never patches the count, so unknown must refuse. ISS-875: session 1584cfcf died on a usage limit at 15 tool calls having created ISS-872, and only the absence of a free device stopped the classifier path (session-failure.ts, which unlike the loop-monitor's `claudeSessionId IS NULL` sweep has no predicate of its own) from creating it a second time.
  if (failed.claudeSessionId != null && meta.toolCallCount !== 0) {
    await alertAbandonedScheduleWork({
      id: failed.id,
      projectId: failed.projectId,
      userId: failed.userId,
      title: failed.title,
      scheduleId: meta.scheduleId,
    });
    return { ok: false, status: 'side-effects' };
  }

  const prior = (meta.failover as ScheduleFailoverState | undefined) ?? {
    attempt: 0,
    triedDeviceIds: [],
  };
  const tried = Array.from(
    new Set([...(prior.triedDeviceIds ?? []), failed.deviceId].filter((d): d is string => !!d)),
  );
  const attempt = (prior.attempt ?? 0) + 1;
  if (attempt > MAX_SCHEDULE_FAILOVERS) return { ok: false, status: 'exhausted' };

  // cm:guard reuse the prompt stored on the failed session; never re-build it — a one-shot skill-improve template re-trips its own idempotency gate on a rebuild and returns null, so the failover would dispatch nothing while reporting success.
  const messages = Array.isArray(failed.messages) ? failed.messages : [];
  const firstUser = messages.find(
    (m): m is { role: string; content: string } =>
      !!m &&
      (m as { role?: string }).role === 'user' &&
      typeof (m as { content?: unknown }).content === 'string',
  );
  if (!firstUser) return { ok: false, status: 'no-prompt' };

  const deviceId = await findAvailableDeviceForProject(failed.projectId, {
    excludeDeviceIds: tried,
  });
  if (!deviceId) return { ok: false, status: 'no-device' };

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, failed.projectId))
    .limit(1);
  if (!project) return { ok: false, status: 'error' };

  const nextMeta: Record<string, unknown> = {
    source: 'schedule.run',
    scheduleId: meta.scheduleId,
    failover: { attempt, triedDeviceIds: tried } satisfies ScheduleFailoverState,
  };
  if (meta.tick) nextMeta.tick = true;
  if (typeof meta.templateKey === 'string') nextMeta.templateKey = meta.templateKey;
  if (meta.steward) nextMeta.steward = true;

  try {
    const session = await createChatSessionRow({
      projectId: failed.projectId,
      userId: failed.userId,
      title: failed.title ?? 'Scheduled run',
      runKind: 'system',
      runMetadata: { source: 'schedule.run', scheduleId: meta.scheduleId },
      metadata: nextMeta,
    });
    const dispatched = await dispatchChatTurn({
      session,
      project,
      client: { deviceId, isLocal: false, migrated: false },
      message: firstUser.content,
      broadcastEvent: 'agent-session.created',
    });
    // cm:why lastStatus:'running' — a failover is a fresh dispatch too; without this the prior 'failed' write lingers as the reported outcome for the whole failover attempt
    try {
      await db
        .update(schedules)
        .set({ lastSessionId: dispatched.id, lastStatus: 'running' })
        .where(eq(schedules.id, meta.scheduleId as string));
    } catch {
      // cm:why swallowed: the re-dispatch itself already committed, and a stale lastStatus only mis-labels the schedule row in the UI until the new session reports
    }
    return { ok: true, status: 'redispatched', sessionId: dispatched.id, deviceId };
  } catch (err) {
    logger.error(
      { err, failedSessionId: sessionId, scheduleId: meta.scheduleId, attempt },
      'schedule.failover: re-dispatch failed',
    );
    return { ok: false, status: 'error' };
  }
}
