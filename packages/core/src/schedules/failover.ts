/**
 * ISS-584 (B) — schedule cross-runner failover, split out of `dispatch.ts`
 * (ISS-875) where it had grown past the file budget beside the unrelated
 * dispatch path. Async and sweeper-driven, mirroring the pipeline job
 * reaper→retry model.
 */

import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchInteractiveTurn,
  firstUserMessageText,
  readSessionAsker,
  setSessionFailureDetail,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions, projects } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { handFireToRetry, recordFireDisposition, scheduleRunIdOf } from './fires.js';
import { schedulesPorts } from './ports.js';
import { authorizeScheduledRun, failUndeliveredRun } from './scheduled-session.js';

const MAX_SCHEDULE_FAILOVERS = 2;

interface ScheduleFailoverState {
  attempt: number;
  triedDeviceIds: string[];
}

type ScheduleFailoverResult =
  | {
      ok: true;
      status: 'redispatched';
      sessionId: string;
      pipelineRunId: string;
      deviceId: string;
    }
  | { ok: false; status: 'authority-refused'; code: string }
  | {
      ok: false;
      status:
        | 'not-schedule'
        | 'exhausted'
        | 'no-device'
        | 'no-prompt'
        | 'no-asker'
        | 'side-effects'
        | 'error';
    };

const FAILOVER_DISPOSITIONS: Record<
  Exclude<ScheduleFailoverResult['status'], 'redispatched' | 'authority-refused'>,
  string
> = {
  'side-effects': 'no failover (session had attached and run tool calls; side effects preserved)',
  'no-device': 'no failover (no other device was available)',
  exhausted: `no failover (chain exhausted after ${MAX_SCHEDULE_FAILOVERS} re-dispatches)`,
  'no-prompt': 'no failover (the failed session carries no prompt to re-run)',
  'not-schedule': 'no failover (not a schedule run)',
  'no-asker': 'no failover (the failed session records no person it ran as)',
  error: 'no failover (the failover attempt threw)',
};

function dispositionOf(result: ScheduleFailoverResult): string {
  if (result.ok) return `cross-device failover (re-dispatched to device ${result.deviceId})`;
  if (result.status === 'authority-refused') {
    return `no failover (${result.code}: the run may no longer act as the person it ran as)`;
  }
  return FAILOVER_DISPOSITIONS[result.status];
}

async function stampFailoverDisposition(
  sessionId: string,
  result: ScheduleFailoverResult,
  failureClass: string | null,
): Promise<void> {
  if (!failureClass) return;
  try {
    await setSessionFailureDetail(sessionId, `${failureClass} → ${dispositionOf(result)}`);
  } catch (err) {
    logger.error(
      { err, sessionId, status: result.status },
      'schedule.failover: disposition write-back threw',
    );
  }
}

async function recordFailoverOnFire(
  failed: FailedScheduleSession,
  result: ScheduleFailoverResult,
): Promise<void> {
  if (!result.ok && result.status === 'not-schedule') return;
  const disposition = dispositionOf(result);
  try {
    const recorded = result.ok
      ? await handFireToRetry({
          failedSessionId: failed.id,
          retry: { id: result.sessionId, pipelineRunId: result.pipelineRunId },
          disposition,
        })
      : await recordFireDisposition({ failedSessionId: failed.id, disposition });
    if (!recorded) {
      logger.warn(
        { sessionId: failed.id, status: result.status },
        'schedule.failover: no fire holds the failed session, so no fire records the failover',
      );
    }
  } catch (err) {
    logger.error({ err, sessionId: failed.id }, 'schedule.failover: fire write threw');
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
  scheduleRunId: string | null;
}): Promise<void> {
  if (!row.userId) return;
  try {
    await schedulesPorts().emitNotification({
      userId: row.userId,
      projectId: row.projectId,
      type: 'schedule_report',
      severity: 'warning',
      agentSessionId: row.id,
      scheduleRunId: row.scheduleRunId,
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
 * incremented failover chain in metadata. The retry acts as the person the
 * failed run acted as, read again now, under a token minted for the new box. Returns a discriminated result, and
 * writes the disposition it settled on back onto the failed row when the caller
 * names the failure class the classifier already published there.
 */
export async function redispatchScheduleSessionOnFailover(
  sessionId: string,
  opts?: { failureClass?: string | null },
): Promise<ScheduleFailoverResult> {
  const [failed] = await db
    .select({
      id: agentSessions.id,
      failureReason: agentSessions.failureReason,
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
  const result = await attemptScheduleFailover(failed);
  await stampFailoverDisposition(sessionId, result, opts?.failureClass ?? null);
  await recordFailoverOnFire(failed, result);
  return result;
}

type FailedScheduleSession = Pick<
  typeof agentSessions.$inferSelect,
  | 'id'
  | 'failureReason'
  | 'projectId'
  | 'userId'
  | 'deviceId'
  | 'title'
  | 'messages'
  | 'metadata'
  | 'claudeSessionId'
>;

async function attemptScheduleFailover(
  failed: FailedScheduleSession,
): Promise<ScheduleFailoverResult> {
  const sessionId = failed.id;
  const meta = (failed.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'schedule.run' || typeof meta.scheduleId !== 'string') {
    return { ok: false, status: 'not-schedule' };
  }

  if (failed.claudeSessionId != null && meta.toolCallCount !== 0) {
    await alertAbandonedScheduleWork({
      id: failed.id,
      projectId: failed.projectId,
      userId: failed.userId,
      title: failed.title,
      scheduleId: meta.scheduleId,
      scheduleRunId: scheduleRunIdOf(meta),
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

  const firstUser = firstUserMessageText(failed.messages);
  if (!firstUser) return { ok: false, status: 'no-prompt' };

  const asker = readSessionAsker(meta.asker);
  if (!asker) return { ok: false, status: 'no-asker' };
  const authorised = await authorizeScheduledRun({
    projectId: failed.projectId,
    asker,
    excludeDeviceIds: tried,
  });
  if (authorised.kind === 'no-device') return { ok: false, status: 'no-device' };
  if (authorised.kind === 'refused') {
    return { ok: false, status: 'authority-refused', code: authorised.refusal.code };
  }
  const { authority } = authorised;

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, failed.projectId))
    .limit(1);
  if (!project) return { ok: false, status: 'error' };

  const nextMeta: Record<string, unknown> = {
    source: 'schedule.run',
    scheduleId: meta.scheduleId,
    asker,
    failover: { attempt, triedDeviceIds: tried } satisfies ScheduleFailoverState,
  };
  const fireId = scheduleRunIdOf(meta);
  if (fireId) nextMeta.scheduleRunId = fireId;
  if (meta.tick) nextMeta.tick = true;

  let session: typeof agentSessions.$inferSelect;
  try {
    session = await createChatSessionRow({
      projectId: failed.projectId,
      userId: asker.userId,
      title: failed.title ?? 'Scheduled run',
      parentSessionId: failed.id,
      runKind: 'system',
      runMetadata: { source: 'schedule.run', scheduleId: meta.scheduleId },
      metadata: nextMeta,
    });
  } catch (err) {
    logger.error(
      { err, failedSessionId: sessionId, scheduleId: meta.scheduleId, attempt },
      'schedule.failover: retry session creation failed',
    );
    return { ok: false, status: 'error' };
  }
  try {
    const dispatched = await dispatchInteractiveTurn({
      session,
      project,
      client: { deviceId: authority.deviceId, isLocal: false, migrated: false },
      authority,
      message: firstUser,
      broadcastEvent: 'agent-session.created',
    });
    return {
      ok: true,
      status: 'redispatched',
      sessionId: dispatched.id,
      pipelineRunId: dispatched.pipelineRunId,
      deviceId: authority.deviceId,
    };
  } catch (err) {
    logger.error(
      { err, failedSessionId: sessionId, scheduleId: meta.scheduleId, attempt },
      'schedule.failover: re-dispatch failed',
    );
    await failUndeliveredRun(session);
    return { ok: false, status: 'error' };
  }
}
