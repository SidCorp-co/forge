import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchInteractiveTurn,
  type SessionRefusal,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { type agentSessions, projects } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import type {
  DispatchScheduleInput,
  DispatchScheduleResult,
  RoutedFire,
} from './dispatch-types.js';
import { attachFireSession, openFire, settleFire } from './fires.js';
import { routeScheduleReleaseBatchFire } from './release-batch-dispatch.js';
import {
  authorizeScheduledRun,
  failUndeliveredRun,
  recordRefusedRun,
  refusalOfMint,
  scheduledAsker,
} from './scheduled-session.js';
import { routeScheduleScriptFire } from './script-dispatch.js';
import { routeScheduleSentryPullFire } from './sentry-pull-dispatch.js';
import { routeScheduleStatusReportFire } from './status-report-dispatch.js';

export async function dispatchScheduleRun(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const fireId = await openFire({
    scheduleId: input.schedule.id,
    projectId: input.schedule.projectId,
    trigger: input.tick ? 'scheduled' : 'manual',
  });
  let routed: RoutedFire;
  try {
    routed = await routeFire(input, fireId);
  } catch (err) {
    await settleFire(fireId, {
      status: 'failed',
      error: `dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  if (routed.settle) await settleFire(fireId, routed.settle);
  return { ...routed.result, fireId };
}

function routeFire(input: DispatchScheduleInput, fireId: string): Promise<RoutedFire> {
  switch (input.schedule.kind) {
    case 'script':
      return routeScheduleScriptFire(input, fireId);
    case 'release_batch':
      return routeScheduleReleaseBatchFire(input, fireId);
    case 'sentry_pull':
      return routeScheduleSentryPullFire(input, fireId);
    case 'status_report':
      return routeScheduleStatusReportFire(input, fireId);
    default:
      return routePromptFire(input, fireId);
  }
}

const skip = (reason: 'project-not-found' | 'no-device'): RoutedFire => ({
  result: { ok: false, reason, status: 'skipped' },
  settle: { status: 'skipped', reason },
});

const sessionFailed = (error: string): RoutedFire => ({
  result: { ok: false, reason: 'session-failed', status: 'failed' },
  settle: { status: 'failed', error },
});

async function routePromptFire(input: DispatchScheduleInput, fireId: string): Promise<RoutedFire> {
  const { schedule } = input;

  if (schedule.prompt == null) return sessionFailed('this prompt-kind schedule has no prompt');

  let resolvedProjectId = schedule.projectId;
  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return skip('project-not-found');
    resolvedProjectId = target.id;
  }

  const [project] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, resolvedProjectId))
    .limit(1);
  if (!project) return skip('project-not-found');

  const asker = scheduledAsker(input.actor, schedule.ownerId);
  const authorised = await authorizeScheduledRun({ projectId: resolvedProjectId, asker });
  if (authorised.kind === 'no-device') return skip('no-device');

  const metadata: Record<string, unknown> = {
    source: 'schedule.run',
    scheduleId: schedule.id,
    scheduleRunId: fireId,
    asker,
  };
  if (input.tick) metadata.tick = true;

  let session: typeof agentSessions.$inferSelect;
  try {
    session = await createChatSessionRow({
      projectId: resolvedProjectId,
      userId: asker?.userId ?? null,
      title: schedule.name?.trim() || 'Scheduled run',
      runKind: 'system',
      runMetadata: { source: 'schedule.run', scheduleId: schedule.id },
      metadata,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id },
      'schedule.dispatch: agent_sessions create failed',
    );
    return sessionFailed(
      `the agent session could not be created: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await attachFireSession(fireId, session);

  if (authorised.kind === 'refused') {
    return refuseRun(session, schedule.id, authorised.refusal);
  }

  let inserted: typeof agentSessions.$inferSelect;
  try {
    inserted = await dispatchInteractiveTurn({
      session,
      project,
      client: { deviceId: authorised.authority.deviceId, migrated: false },
      authority: authorised.authority,
      message: schedule.prompt,
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    const refusal = refusalOfMint(err);
    if (refusal) return refuseRun(session, schedule.id, refusal);
    logger.error(
      { err, sessionId: session.id, scheduleId: schedule.id },
      'schedule.dispatch: chat-turn dispatch failed',
    );
    await failUndeliveredRun(session, err);
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed', sessionId: session.id },
      settle: null,
    };
  }

  return {
    result: { ok: true, sessionId: inserted.id, status: 'running', resolvedProjectId },
    settle: null,
  };
}

async function refuseRun(
  session: typeof agentSessions.$inferSelect,
  scheduleId: string,
  refusal: SessionRefusal,
): Promise<RoutedFire> {
  await recordRefusedRun({ session, scheduleId, refusal });
  return {
    result: { ok: false, reason: 'refused', status: 'failed', sessionId: session.id, refusal },
    settle: null,
  };
}
