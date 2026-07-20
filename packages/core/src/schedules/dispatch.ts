import { eq } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchChatTurn,
  resolveChatDevice,
} from '../agent-sessions/chat-turn.js';
import { db } from '../db/client.js';
import {
  type ScheduleKind,
  type ScheduleMode,
  agentSessions,
  projects,
  scheduleRuns,
  schedules,
} from '../db/schema.js';
import { findAvailableDeviceForProject } from '../lib/device-pool.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { hooks } from '../pipeline/hooks.js';
import { buildDriftCheckPrompt } from './messages/drift-check-prompt.js';
import { buildFeedbackDigestPrompt } from './messages/feedback-digest-prompt.js';
import { buildProductMapRefreshPrompt } from './messages/product-map-refresh-prompt.js';
import { getImprovementMessage } from './messages/registry.js';
import { type AppliedVersions, buildSkillImprovePrompt } from './messages/skill-improve-prompt.js';
import { buildSkillStewardPrompt } from './messages/skill-steward-prompt.js';
import { runScheduleScript } from './script/executor.js';

// Keys for standing templates that build their own prompt instead of the steward.
// Add new standing-template keys here when they have a dedicated builder.
const DRIFT_CHECK_KEY = 'knowledge-drift-check';
const PRODUCT_MAP_KEY = 'product-map-refresh';
const FEEDBACK_DIGEST_KEY = 'feedback-triage-digest';

// Standing templates with a DEDICATED non-steward builder: their sessions must
// NOT be tagged metadata.steward (the steward-report parser would mis-handle
// them — their effect is draft issues / upserted knowledge entries, not a
// steward report). Add a key here whenever you add a non-steward standing builder.
const NON_STEWARD_STANDING_KEYS = new Set<string>([
  DRIFT_CHECK_KEY,
  PRODUCT_MAP_KEY,
  FEEDBACK_DIGEST_KEY,
]);

export interface ScheduleRowForDispatch {
  id: string;
  name?: string | null;
  projectId: string;
  // Nullable: a kind='script' schedule carries no prompt at all (ISS-618).
  prompt: string | null;
  runner: 'desktop' | 'antigravity';
  targetProjectSlug: string | null;
  /** When set, the skill-improve engine builds the prompt instead of using `prompt`. */
  templateKey?: string | null;
  params?: Record<string, unknown> | null;
  mode?: ScheduleMode | null;
  appliedMessageVersions?: AppliedVersions | null;
  // ISS-618 — 'script' schedules run a sandboxed script, no agent session at all.
  kind?: ScheduleKind | null;
  script?: string | null;
}

export interface DispatchScheduleInput {
  schedule: ScheduleRowForDispatch;
  // Manual triggers attribute the session to the calling user; tick triggers
  // fall back to the resolved project's creator (agent_sessions.user_id is
  // nullable but useful to populate for audit + activity feeds).
  actorUserId?: string;
  // Marks the resulting session metadata so consumers can distinguish
  // tick-driven runs from manual /:id/run triggers.
  tick?: boolean;
  // When the caller has already resolved `targetProjectSlug` (e.g. the route's
  // auth gate), pass the resolved project here to skip a redundant lookup.
  resolvedTarget?: { id: string; createdBy: string };
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
      reason: 'project-not-found' | 'no-device' | 'unsupported-runner' | 'already-applied';
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

  // ISS-618 — script-kind schedules run a sandboxed script directly in core;
  // they need no device, no agent session, and no Claude runner at all, so
  // this branches BEFORE the desktop-runner guard below (which doesn't apply).
  if (schedule.kind === 'script') {
    return dispatchScheduleScriptRun(input);
  }

  // Antigravity adapter is HTTP-push and lives behind the (now-bypassed)
  // jobs/dispatcher path. Until antigravity gains an interactive WS entry
  // point, only desktop schedules can ride this code path.
  if (schedule.runner !== 'desktop') {
    return { ok: false, reason: 'unsupported-runner', status: 'skipped' };
  }

  if (schedule.prompt == null && !schedule.templateKey) {
    logger.error(
      { scheduleId: schedule.id },
      'schedule.dispatch: prompt-kind schedule has neither prompt nor templateKey',
    );
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  // ISS-548/ISS-556 — when a schedule has a templateKey, build the prompt
  // BEFORE any DB lookups.
  // - Standing templates (standing===true) bypass appliedMessageVersions — every
  //   cadence run fires unconditionally; the steward always has fresh signals.
  // - One-shot templates still return null when already applied at current version
  //   → return skipped early to avoid a wasted round-trip.
  // Guarded above: reaching here means either templateKey is set (about to
  // overwrite effectivePrompt unconditionally) or schedule.prompt is non-null.
  let effectivePrompt: string = schedule.prompt ?? '';
  let isStandingTemplate = false;
  if (schedule.templateKey) {
    const registryEntry = getImprovementMessage(schedule.templateKey);
    if (registryEntry?.standing) {
      // Standing template: always dispatch, bypass appliedMessageVersions.
      isStandingTemplate = true;
      if (schedule.templateKey === DRIFT_CHECK_KEY) {
        effectivePrompt = buildDriftCheckPrompt({
          mode: schedule.mode ?? 'propose',
          projectId: schedule.projectId,
        });
        logger.info(
          { scheduleId: schedule.id, templateKey: schedule.templateKey },
          'schedule.dispatch: standing drift-check template dispatching (bypassing appliedMessageVersions)',
        );
      } else if (schedule.templateKey === PRODUCT_MAP_KEY) {
        effectivePrompt = buildProductMapRefreshPrompt({
          mode: schedule.mode ?? 'auto',
          projectId: schedule.projectId,
        });
        logger.info(
          { scheduleId: schedule.id, templateKey: schedule.templateKey },
          'schedule.dispatch: standing product-map-refresh template dispatching (bypassing appliedMessageVersions)',
        );
      } else if (schedule.templateKey === FEEDBACK_DIGEST_KEY) {
        effectivePrompt = buildFeedbackDigestPrompt({
          mode: schedule.mode ?? 'propose',
          projectId: schedule.projectId,
        });
        logger.info(
          { scheduleId: schedule.id, templateKey: schedule.templateKey },
          'schedule.dispatch: standing feedback-digest template dispatching (bypassing appliedMessageVersions)',
        );
      } else {
        effectivePrompt = buildSkillStewardPrompt({
          mode: schedule.mode ?? 'propose',
          projectId: schedule.projectId,
        });
        logger.info(
          { scheduleId: schedule.id, templateKey: schedule.templateKey },
          'schedule.dispatch: standing steward template dispatching (bypassing appliedMessageVersions)',
        );
      }
    } else {
      // One-shot template: use existing idempotency gate.
      const built = buildSkillImprovePrompt({
        templateKey: schedule.templateKey,
        mode: schedule.mode ?? 'propose',
        appliedMessageVersions: schedule.appliedMessageVersions ?? null,
      });
      if (built === null) {
        logger.info(
          { scheduleId: schedule.id, templateKey: schedule.templateKey },
          'schedule.dispatch: skill-improve prompt skipped — message already applied at current version',
        );
        return { ok: false, reason: 'already-applied', status: 'skipped' };
      }
      effectivePrompt = built;
    }
  }

  let resolvedProjectId = schedule.projectId;
  let resolvedCreatedBy: string | undefined;

  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, createdBy: projects.createdBy })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return { ok: false, reason: 'project-not-found', status: 'skipped' };
    resolvedProjectId = target.id;
    resolvedCreatedBy = target.createdBy;
  }

  // FIXME(iss-257): tick-driven sessions attribute to the project creator
  // (audit `projects.created_by`) because the activity-feed expectations want
  // a real user. A sentinel system user requires a separate migration —
  // tracked for follow-up. Consumers can detect tick-driven sessions by
  // `metadata.tick === true`.
  const userId = input.actorUserId ?? (await loadCreatedBy(resolvedProjectId, resolvedCreatedBy));
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
  // ISS-548/ISS-556 — carry templateKey in session metadata so the session-completion
  // handler can locate the schedule row and write back applied_message_versions (one-shot)
  // or persist the steward run report (standing).
  if (schedule.templateKey) metadata.templateKey = schedule.templateKey;
  // ISS-556 — tag standing sessions so the completion handler routes to the
  // steward report parser instead of the one-shot skill-improve parser.
  // Drift-check + product-map-refresh + feedback-digest are standing but do NOT
  // use the steward report format (they create draft issues / upsert knowledge
  // directly), so the parser must skip them — see NON_STEWARD_STANDING_KEYS.
  if (
    isStandingTemplate &&
    !(schedule.templateKey != null && NON_STEWARD_STANDING_KEYS.has(schedule.templateKey))
  ) {
    metadata.steward = true;
  }

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
      message: effectivePrompt,
      // Parity with /start — web subscribers add the new session to their list.
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, scheduleId: schedule.id },
      'schedule.dispatch: chat-turn dispatch failed',
    );
    try {
      await applyKernelTransition(db, {
        entity: 'session',
        to: 'failed',
        set: { failureReason: 'ws-publish-failed' },
        where: eq(agentSessions.id, session.id),
        fromStatus: session.status,
        reason: 'ws-publish-failed',
        actor: { type: 'system' },
        source: 'schedule',
      });
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

/**
 * ISS-618 — script-kind schedule dispatch. Runs a sandboxed Node.js script
 * (see ./script/executor.ts) on the cron cadence with NO agent_sessions row
 * and NO Claude runner involved. History goes to `schedule_runs` instead of
 * `agent_sessions`; `sessionId` in the returned result is actually the
 * `schedule_runs.id`, kept under the same field name so callers (routes.ts /
 * service.ts) that only look at `result.status` / `result.sessionId` need no
 * branching of their own.
 */
async function dispatchScheduleScriptRun(
  input: DispatchScheduleInput,
): Promise<DispatchScheduleResult> {
  const { schedule } = input;

  if (!schedule.script) {
    logger.error(
      { scheduleId: schedule.id },
      'schedule.dispatch: script-kind schedule has no script',
    );
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  let resolvedProjectId = schedule.projectId;
  if (schedule.targetProjectSlug) {
    const target =
      input.resolvedTarget ??
      (
        await db
          .select({ id: projects.id, createdBy: projects.createdBy })
          .from(projects)
          .where(eq(projects.slug, schedule.targetProjectSlug))
          .limit(1)
      )[0];
    if (!target) return { ok: false, reason: 'project-not-found', status: 'skipped' };
    resolvedProjectId = target.id;
  }

  const userId =
    input.actorUserId ?? (await loadCreatedBy(resolvedProjectId, input.resolvedTarget?.createdBy));
  if (!userId) return { ok: false, reason: 'project-not-found', status: 'skipped' };

  const startedAt = new Date();
  const [run] = await db
    .insert(scheduleRuns)
    .values({
      scheduleId: schedule.id,
      projectId: resolvedProjectId,
      trigger: input.tick ? 'scheduled' : 'manual',
      status: 'running',
      startedAt,
    })
    .returning({ id: scheduleRuns.id });
  if (!run) {
    logger.error({ scheduleId: schedule.id }, 'schedule.dispatch: schedule_runs insert failed');
    return { ok: false, reason: 'session-failed', status: 'failed' };
  }

  const outcome = await runScheduleScript({
    script: schedule.script,
    params: schedule.params ?? null,
  });

  try {
    await db
      .update(scheduleRuns)
      .set({
        status: outcome.status,
        output: outcome.output,
        error: outcome.status === 'failed' ? outcome.error : null,
        finishedAt: new Date(),
      })
      .where(eq(scheduleRuns.id, run.id));
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, runId: run.id },
      'schedule.dispatch: schedule_runs update failed',
    );
  }

  // Deliver ctx.notify() payloads best-effort — a failed delivery must not
  // flip an otherwise-successful script run to failed.
  for (const n of outcome.notifications) {
    try {
      await emitNotification({
        userId,
        projectId: resolvedProjectId,
        type: 'schedule_report',
        title: n.title,
        body: n.body ?? null,
      });
    } catch (err) {
      logger.error(
        { err, scheduleId: schedule.id, runId: run.id },
        'schedule.dispatch: schedule_report notification delivery failed',
      );
    }
  }

  try {
    await hooks.emit('scheduleRun', {
      scheduleId: schedule.id,
      projectId: resolvedProjectId,
      sessionId: run.id,
      actorUserId: userId,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, runId: run.id },
      'schedule.dispatch: scheduleRun hook threw',
    );
  }

  if (outcome.status === 'failed') {
    return { ok: false, reason: 'session-failed', status: 'failed', sessionId: run.id };
  }
  return { ok: true, sessionId: run.id, status: 'success', resolvedProjectId };
}

// ── ISS-584 (B): schedule cross-runner failover ────────────────────────────
// Async, sweeper-driven (mirrors the pipeline job reaper→retry model). When the
// loop-monitor fails a schedule session with `no_client_ack` (the runner it was
// sent to never attached → claudeSessionId still NULL → ZERO side effects ran),
// re-dispatch the SAME prompt to a DIFFERENT online runner, excluding every
// device already tried. Bounded by MAX_SCHEDULE_FAILOVERS so a project with no
// healthy runner converges to a plain `failed` instead of looping.
//
// Safety boundary: ONLY no_client_ack (never attached) is retried. A
// `heartbeat_timeout` schedule session DID attach and may have run side effects
// (created issues, applied skills) before dying — re-running it is unsafe, so it
// is left failed (the next cron firing is the recovery there).

const MAX_SCHEDULE_FAILOVERS = 2; // total devices tried across a chain = 3

interface ScheduleFailoverState {
  attempt: number;
  triedDeviceIds: string[];
}

export type ScheduleFailoverResult =
  | { ok: true; status: 'redispatched'; sessionId: string; deviceId: string }
  | { ok: false; status: 'not-schedule' | 'exhausted' | 'no-device' | 'no-prompt' | 'error' };

/**
 * Re-dispatch a schedule session that the loop-monitor just failed with
 * `no_client_ack`, onto another runner. Idempotent-safe: it reads the prompt
 * already materialized on the failed session (no prompt re-build) and creates a
 * fresh `system` session for the retry, carrying an incremented failover chain
 * in metadata. Returns a discriminated result for the caller to log.
 */
export async function redispatchScheduleSessionOnFailover(
  sessionId: string,
): Promise<ScheduleFailoverResult> {
  const [failed] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      userId: agentSessions.userId,
      deviceId: agentSessions.deviceId,
      title: agentSessions.title,
      messages: agentSessions.messages,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!failed) return { ok: false, status: 'error' };

  const meta = (failed.metadata ?? {}) as Record<string, unknown>;
  if (meta.source !== 'schedule.run' || typeof meta.scheduleId !== 'string') {
    return { ok: false, status: 'not-schedule' };
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

  // Reuse the prompt already on the failed session — never re-build (a one-shot
  // skill-improve template would re-trip its idempotency gate; the stored text
  // is the exact prompt that was meant to run).
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

  // Carry forward the original schedule metadata flags + the bumped failover chain.
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
    // Point the schedule's "last run" link at the live attempt (best-effort —
    // a failure here only staleness the UI link, never the re-dispatch).
    try {
      await db
        .update(schedules)
        .set({ lastSessionId: dispatched.id })
        .where(eq(schedules.id, meta.scheduleId as string));
    } catch {
      // ignore
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

async function loadCreatedBy(projectId: string, hint?: string): Promise<string | undefined> {
  if (hint) return hint;
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy;
}
