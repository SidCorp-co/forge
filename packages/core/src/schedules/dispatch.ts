import { eq } from 'drizzle-orm';
import { createChatSessionRow } from '../agent-sessions/chat-turn.js';
import {
  dispatchInteractiveTurn,
  type SessionRefusal,
} from '../agent-sessions/interactive-credential.js';
import { db } from '../db/client.js';
import type { ScheduleMode } from '../db/schema.js';
import { type agentSessions, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { hooks } from '../pipeline/hooks.js';
import type {
  DispatchScheduleInput,
  DispatchScheduleResult,
  RoutedFire,
} from './dispatch-types.js';
import { attachFireSession, openFire, settleFire } from './fires.js';
import { buildDriftCheckPrompt } from './messages/drift-check-prompt.js';
import { buildFeedbackDigestPrompt } from './messages/feedback-digest-prompt.js';
import { buildProductMapRefreshPrompt } from './messages/product-map-refresh-prompt.js';
import { getImprovementMessage } from './messages/registry.js';
import { buildSkillImprovePrompt } from './messages/skill-improve-prompt.js';
import { buildSkillStewardPrompt } from './messages/skill-steward-prompt.js';
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

type StandingBuilder = (input: { mode: ScheduleMode; projectId: string }) => string;

const STANDING_BUILDERS: Record<string, { build: StandingBuilder; defaultMode: ScheduleMode }> = {
  [DRIFT_CHECK_KEY]: { build: buildDriftCheckPrompt, defaultMode: 'propose' },
  [PRODUCT_MAP_KEY]: { build: buildProductMapRefreshPrompt, defaultMode: 'auto' },
  [FEEDBACK_DIGEST_KEY]: { build: buildFeedbackDigestPrompt, defaultMode: 'propose' },
};

/**
 * Resolves the prompt a prompt-kind schedule dispatches with, before any DB
 * lookup. Returns `null` when a ONE-SHOT template was already applied at its
 * current version — the caller turns that into a `skipped` result. Standing
 * templates never return null: they bypass `appliedMessageVersions` because
 * their value is in observing fresh signals on every cadence run.
 */
export function resolveTemplatePrompt(schedule: {
  id: string;
  projectId: string;
  prompt: string | null;
  templateKey?: string | null;
  mode?: ScheduleMode | null;
  appliedMessageVersions?: Record<string, number> | null;
}): { prompt: string; standing: boolean } | null {
  const { templateKey } = schedule;
  if (!templateKey) return { prompt: schedule.prompt ?? '', standing: false };

  if (getImprovementMessage(templateKey)?.standing) {
    const entry = STANDING_BUILDERS[templateKey];
    const build = entry?.build ?? buildSkillStewardPrompt;
    logger.info(
      { scheduleId: schedule.id, templateKey },
      'schedule.dispatch: standing template dispatching (bypassing appliedMessageVersions)',
    );
    return {
      prompt: build({
        mode: schedule.mode ?? entry?.defaultMode ?? 'propose',
        projectId: schedule.projectId,
      }),
      standing: true,
    };
  }

  const built = buildSkillImprovePrompt({
    templateKey,
    mode: schedule.mode ?? 'propose',
    appliedMessageVersions: schedule.appliedMessageVersions ?? null,
  });
  if (built === null) {
    logger.info(
      { scheduleId: schedule.id, templateKey },
      'schedule.dispatch: skill-improve prompt skipped — message already applied at current version',
    );
    return null;
  }
  return { prompt: built, standing: false };
}

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
    default:
      return routePromptFire(input, fireId);
  }
}

const skip = (reason: 'project-not-found' | 'no-device' | 'already-applied'): RoutedFire => ({
  result: { ok: false, reason, status: 'skipped' },
  settle: { status: 'skipped', reason },
});

const sessionFailed = (error: string): RoutedFire => ({
  result: { ok: false, reason: 'session-failed', status: 'failed' },
  settle: { status: 'failed', error },
});

async function routePromptFire(input: DispatchScheduleInput, fireId: string): Promise<RoutedFire> {
  const { schedule } = input;

  if (schedule.prompt == null && !schedule.templateKey) {
    return sessionFailed('this prompt-kind schedule has neither a prompt nor a templateKey');
  }

  if (schedule.templateKey && !getImprovementMessage(schedule.templateKey)) {
    return sessionFailed(
      `templateKey '${schedule.templateKey}' names no registered improvement message, so this fire has no prompt to send`,
    );
  }
  const resolved = resolveTemplatePrompt(schedule);
  if (resolved === null) return skip('already-applied');
  const { prompt: effectivePrompt, standing: isStandingTemplate } = resolved;

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
    .select({
      id: projects.id,
      slug: projects.slug,
    })
    .from(projects)
    .where(eq(projects.id, resolvedProjectId))
    .limit(1);
  if (!project) return skip('project-not-found');

  const asker = scheduledAsker(input.actor, schedule.ownerId);
  const authorised = await authorizeScheduledRun({ projectId: resolvedProjectId, asker });
  if (authorised.kind === 'no-device') return skip('no-device');

  const title = schedule.name?.trim() || 'Scheduled run';
  const metadata: Record<string, unknown> = {
    source: 'schedule.run',
    scheduleId: schedule.id,
    scheduleRunId: fireId,
    asker,
  };
  if (input.tick) metadata.tick = true;
  if (schedule.templateKey) metadata.templateKey = schedule.templateKey;
  if (
    isStandingTemplate &&
    !(schedule.templateKey != null && NON_STEWARD_STANDING_KEYS.has(schedule.templateKey))
  ) {
    metadata.steward = true;
  }

  let session: typeof agentSessions.$inferSelect;
  try {
    session = await createChatSessionRow({
      projectId: resolvedProjectId,
      userId: asker?.userId ?? null,
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
      project: { id: project.id, slug: project.slug },
      client: { deviceId: authorised.authority.deviceId, isLocal: false, migrated: false },
      authority: authorised.authority,
      message: effectivePrompt,
      broadcastEvent: 'agent-session.created',
    });
  } catch (err) {
    const refusal = refusalOfMint(err);
    if (refusal) return refuseRun(session, schedule.id, refusal);
    logger.error(
      { err, sessionId: session.id, scheduleId: schedule.id },
      'schedule.dispatch: chat-turn dispatch failed',
    );
    await failUndeliveredRun(session);
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed', sessionId: session.id },
      settle: null,
    };
  }

  try {
    await hooks.emit('scheduleRun', {
      scheduleId: schedule.id,
      projectId: resolvedProjectId,
      sessionId: inserted.id,
      actorUserId: authorised.authority.value.authority.userId,
    });
  } catch (err) {
    logger.error(
      { err, scheduleId: schedule.id, sessionId: inserted.id },
      'schedule.dispatch: scheduleRun hook threw',
    );
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

export type {
  DispatchScheduleInput,
  DispatchScheduleResult,
  ScheduleRowForDispatch,
} from './dispatch-types.js';
export { redispatchScheduleSessionOnFailover } from './failover.js';
