import { eq } from 'drizzle-orm';
import { broadcastSession, broadcastTurnAppended } from '../agent-sessions/broadcast.js';
import { syncTurnsWithMessages } from '../agent-sessions/turns-helpers.js';
import { db } from '../db/client.js';
import { agentSessions, projects, schedules } from '../db/schema.js';
import { buildChatPreamble, TOOL_REFERENCE } from '../lib/chat-preamble.js';
import { findAvailableDeviceForProject, resolveRepoPath, resolveRunnerRepoPath } from '../lib/device-pool.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import { openOneShotRun } from '../pipeline/runs.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

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
  const userId =
    input.actorUserId ?? (await loadOwnerId(resolvedProjectId, resolvedOwnerId));
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
  const deviceId = await findAvailableDeviceForProject(resolvedProjectId);
  if (!deviceId) {
    return { ok: false, reason: 'no-device', status: 'skipped' };
  }

  // ISS-101 — schedule runs are project-scoped one-shots with no issueId;
  // open a 'system' run so agent_sessions.pipeline_run_id can be satisfied.
  const run = await openOneShotRun({
    projectId: resolvedProjectId,
    kind: 'system',
    metadata: { source: 'schedule.run', scheduleId: schedule.id },
  });

  // cwd for `claude` runs on the chosen runner's box → prefer its binding path.
  const bindingRepo = await resolveRunnerRepoPath(resolvedProjectId, deviceId);
  const repoPath = resolveRepoPath(null, bindingRepo ?? project.repoPath ?? null);
  const nowDate = new Date();
  const userMessage = {
    role: 'user',
    content: schedule.prompt,
    timestamp: nowDate.getTime(),
  };
  const title = schedule.name?.trim() || 'Scheduled run';

  const metadata: Record<string, unknown> = {
    source: 'schedule.run',
    scheduleId: schedule.id,
    deviceId,
  };
  if (input.tick) metadata.tick = true;

  let inserted: typeof agentSessions.$inferSelect;
  try {
    const txResult = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: resolvedProjectId,
          userId,
          deviceId,
          pipelineRunId: run.id,
          title,
          status: 'running',
          startedAt: nowDate,
          lastHeartbeatAt: nowDate,
          repoPath: repoPath ?? null,
          messages: [userMessage] as never,
          metadata: metadata as never,
        })
        .returning();
      if (!row) throw new Error('agent_sessions: insert returned no row');
      // Materialize the seed user turn inside the same transaction so the
      // legacy blob and turn rows can never diverge if the turn insert throws.
      const sync = await syncTurnsWithMessages(row.id, [], [userMessage], tx);
      return { inserted: row, startSync: sync };
    });
    inserted = txResult.inserted;
    for (const t of txResult.startSync.appended) {
      broadcastTurnAppended(inserted, t);
    }
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id },
      'schedule.dispatch: agent_sessions insert failed',
    );
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  // Best-effort preamble — gives the CLI project context (mirrors /start at
  // packages/core/src/agent-sessions/routes.ts:549). Non-fatal: schedule
  // prompts are typically self-contained.
  let enrichedPrompt = schedule.prompt;
  try {
    const preamble = await buildChatPreamble(resolvedProjectId);
    enrichedPrompt = preamble + schedule.prompt;
  } catch {
    // non-fatal — proceed with raw prompt
  }

  // WS publish — fresh-session entry point on the desktop runner. Matches the
  // non-desktop, non-agent branch of /start (routes.ts:558). If publish
  // throws, the session row is orphan (status=running, no claudeSessionId).
  // Mark it failed so the schedule's `lastStatus` (and the UI) reflects
  // reality on the next ZapierSweeper / retention pass.
  try {
    roomManager.publish(deviceRoom(deviceId), {
      event: 'agent:start',
      data: {
        sessionId: inserted.id,
        repoPath,
        prompt: enrichedPrompt,
        projectSlug: project.slug,
        preBuilt: false,
        systemPrompt: TOOL_REFERENCE,
      },
    });
  } catch (err) {
    logger.error(
      { err, sessionId: inserted.id, scheduleId: schedule.id },
      'schedule.dispatch: agent:start publish failed',
    );
    try {
      await db
        .update(agentSessions)
        .set({ status: 'failed', failureReason: 'ws-publish-failed' })
        .where(eq(agentSessions.id, inserted.id));
    } catch (cleanupErr) {
      logger.error(
        { err: cleanupErr, sessionId: inserted.id },
        'schedule.dispatch: failed to mark session failed after publish failure',
      );
    }
    return { ok: false, reason: 'session-failed', status: 'failed', sessionId: inserted.id };
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

  // Broadcast `agent-session.created` to the project room for parity with
  // `/api/agent-sessions/start` — web subscribers refresh their session list.
  broadcastSession(inserted, 'agent-session.created');

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
