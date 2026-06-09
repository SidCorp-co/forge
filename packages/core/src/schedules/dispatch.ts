import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../agent-sessions/chat-turn.js';
import { db } from '../db/client.js';
import { agentSessions, projects, schedules } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';

export interface ScheduleRowForDispatch {
  id: string;
  name?: string | null;
  projectId: string;
  prompt: string;
  runner: 'desktop' | 'antigravity';
  targetProjectSlug: string | null;
}

export interface DispatchScheduleInput {
  schedule: ScheduleRowForDispatch;
  // Manual triggers attribute the session to the calling user; tick triggers
  // fall back to the resolved project's owner (agent_sessions.user_id is
  // nullable but useful to populate for audit + activity feeds).
  actorUserId?: string;
  // Marks the resulting session metadata so consumers can distinguish
  // tick-driven runs from manual /:id/run triggers.
  tick?: boolean;
  // When the caller has already resolved `targetProjectSlug` (e.g. the route's
  // auth gate), pass the resolved project here to skip a redundant lookup.
  resolvedTarget?: { id: string; ownerId: string };
}

// `success` here means: the agent_sessions row was created + WS publish was
// emitted to the device. It does NOT mean the prompt completed — the session
// has its own lifecycle (running → completed/failed/cancelled_stale) tracked
// by the runner's heartbeat. `skipped` causes are bounded by what the
// dispatcher can detect synchronously; tick callers use them to back off
// quietly while manual callers turn them into 4xx responses.
export type DispatchScheduleResult =
  | { ok: true; sessionId: string; status: 'success'; resolvedProjectId: string }
  | {
      ok: false;
      reason: 'project-not-found' | 'no-device' | 'unsupported-runner';
      status: 'skipped';
    }
  | { ok: false; reason: 'session-failed'; status: 'failed'; sessionId?: string };

/**
 * Reroute schedule.run onto the interactive agent-session rails used by
 * `POST /api/agent-sessions/start`. The schedule prompt is delivered to the
 * desktop runner via `agent:start` WS broadcast — there is no `jobs` row,
 * no dispatcher, no capability gate. Each scheduled run shows up in
 * `/settings/sessions` with full turn history, indistinguishable from a
 * user-initiated chat (except for `metadata.source='schedule.run'`).
 *
 * Why this design (vs the old jobs/dispatcher path):
 *  - `jobs(type='custom')` failed the dispatcher capability gate permanently
 *    (`runner_unsupported_type:claude-code`) because `custom` is excluded
 *    from `RUNNER_CAPABILITIES` by design — it has no canonical runner
 *    mapping. Forcing schedules through that gate was type-laundering.
 *  - Schedules are conceptually "automated new-chat sessions" — they should
 *    ride the same rails as `/api/agent-sessions/start`.
 *  - Pure of any direct mutation on `schedules.lastStatus` — caller updates
 *    `lastStatus` from the returned `status`. `lastSessionId` IS updated
 *    here (best-effort) so the UI's "last run" link resolves.
 *
 * Antigravity runner is rejected at create/update time
 * (SCHEDULE_RUNNER_NOT_SUPPORTED). The check at the top of this function is
 * defensive for any pre-existing row that may have slipped past the gate.
 */
export async function dispatchScheduleRun(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const { schedule } = input;

  // Antigravity adapter is HTTP-push and lives behind the (now-bypassed)
  // jobs/dispatcher path. Until antigravity gains an interactive WS entry
  // point, only desktop schedules can ride this code path.
  if (schedule.runner !== 'desktop') {
    return { ok: false, reason: 'unsupported-runner', status: 'skipped' };
  }

  let resolvedProjectId = schedule.projectId;
  let resolvedOwnerId: string | undefined;

  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, ownerId: projects.ownerId })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return { ok: false, reason: 'project-not-found', status: 'skipped' };
    resolvedProjectId = target.id;
    resolvedOwnerId = target.ownerId;
  }

  // FIXME(iss-257): tick-driven sessions attribute to the project owner
  // because the activity-feed expectations want a real user. A sentinel
  // system user requires a separate migration — tracked for follow-up.
  // Consumers can detect tick-driven sessions by `metadata.tick === true`.
  const userId = input.actorUserId ?? (await loadOwnerId(resolvedProjectId, resolvedOwnerId));
  if (!userId) return { ok: false, reason: 'project-not-found', status: 'skipped' };

  // Look up project slug + repoPath in one shot for the WS payload.
  const [project] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      repoPath: projects.repoPath,
    })
    .from(projects)
    .where(eq(projects.id, resolvedProjectId))
    .limit(1);
  if (!project) return { ok: false, reason: 'project-not-found', status: 'skipped' };

  // Device pool is the source of truth for "is a desktop runner ready?".
  // Tick: no device → `skipped` (the schedule's `lastStatus` reflects this
  //   and the next cron firing tries again).
  // Manual /run: no device → caller turns `skipped` into a 409 so the user
  //   knows nothing was started. There is no queue to wait on now.
  // Schedules are always REMOTE (no desktop origin) — same device resolution as
  // chat so the two cannot drift.
  const client = await resolveChatDevice(
    { projectId: resolvedProjectId, deviceId: null, metadata: null },
    undefined,
  );
  if (!client.deviceId) {
    return { ok: false, reason: 'no-device', status: 'skipped' };
  }

  const title = schedule.name?.trim() || 'Scheduled run';
  const metadata: Record<string, unknown> = { source: 'schedule.run', scheduleId: schedule.id };
  if (input.tick) metadata.tick = true;

  // ISS-101 — schedule runs are project-scoped one-shots with no issueId; open a
  // 'system' run via the shared chat-session creator, then deliver the prompt
  // through the ONE chat-turn dispatcher (it pins the device + publishes
  // `agent:start` with the tool reference + preamble, identical to /start).
  let session: typeof agentSessions.$inferSelect;
  try {
    session = await createChatSessionRow({
      projectId: resolvedProjectId,
      userId,
      title,
      runKind: 'system',
      runMetadata: { source: 'schedule.run', scheduleId: schedule.id },
      metadata,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id },
      'schedule.dispatch: agent_sessions create failed',
    );
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  // If the WS publish (inside the dispatcher) throws, the row is left `running`
  // with no claudeSessionId. Mark it failed so the schedule's `lastStatus` (and
  // the UI) reflects reality on the next sweeper / retention pass — schedules
  // are unattended, so we cannot rely on a user seeing a 500.
  let inserted: typeof agentSessions.$inferSelect;
  try {
    inserted = await dispatchChatTurn({
      session,
      project: { id: project.id, slug: project.slug, repoPath: project.repoPath },
      client,
      message: schedule.prompt,
      // Parity with /start — web subscribers add the new session to their list.
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, scheduleId: schedule.id },
      'schedule.dispatch: chat-turn dispatch failed',
    );
    try {
      await db
        .update(agentSessions)
        .set({ status: 'failed', failureReason: 'ws-publish-failed' })
        .where(eq(agentSessions.id, session.id));
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, sessionId: session.id },
        'schedule.dispatch: failed to mark session failed after dispatch failure',
      );
    }
    return { ok: false, reason: 'session-failed', status: 'failed', sessionId: session.id };
  }

  // Point lastSessionId at this attempt now that the WS publish committed.
  // Best-effort: a failure here only means the UI's "last run" link is stale.
  try {
    await db
      .update(schedules)
      .set({ lastSessionId: inserted.id })
      .where(eq(schedules.id, schedule.id));
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, sessionId: inserted.id },
      'schedule.dispatch: lastSessionId update failed',
    );
  }

  // (The `agent-session.created` broadcast happens inside `dispatchChatTurn`.)

  // Hook subscribers are best-effort — a throw here must not fail the
  // dispatch (the session row + WS publish already committed).
  try {
    await hooks.emit('scheduleRun', {
      scheduleId: schedule.id,
      projectId: resolvedProjectId,
      sessionId: inserted.id,
      actorUserId: userId,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, sessionId: inserted.id },
      'schedule.dispatch: scheduleRun hook threw',
    );
  }

  return { ok: true, sessionId: inserted.id, status: 'success', resolvedProjectId };
}

async function loadOwnerId(projectId: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.ownerId;
}
