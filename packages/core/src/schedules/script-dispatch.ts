// A script-kind schedule's fire (ISS-618): the script runs in the script sandbox (REQ-37), which a
// chat computation runs in too. ctx.log and ctx.notify are as they were (BC-10); ctx.forge.get reads
// the run's project as the person the fire acts for (whoever pressed run, else the schedule's
// owner), and the fire records who that was and every read it made with its status (BC-9).

import { logger } from '../lib/logger.js';
import { openForgeReader, runScript } from '../sandbox/index.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { schedulesPorts } from './ports.js';
import { resolveScheduleTargetProject } from './release-batch-dispatch.js';
import { scheduledAsker } from './scheduled-session.js';

const SCRIPT_WALL_MS = 30_000;
const SCRIPT_MEMORY_MB = 64;
const MAX_OUTPUT_CHARS = 16_000;
/** How long past the run's wall cap its read token lives, so it never outlives the run by more. */
const TOKEN_MARGIN_MS = 5_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

export async function routeScheduleScriptFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { schedule } = input;

  if (!schedule.script) {
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed' },
      settle: { status: 'failed', error: 'this script-kind schedule has no script' },
    };
  }

  const resolved = await resolveScheduleTargetProject(input);
  if (!resolved) {
    return {
      result: { ok: false, reason: 'project-not-found', status: 'skipped' },
      settle: { status: 'skipped', reason: 'project-not-found' },
    };
  }
  const { projectId: resolvedProjectId, userId } = resolved;
  const owner = scheduledAsker(input.actor, schedule.ownerId);

  const reader = openForgeReader({
    projectId: resolvedProjectId,
    owner,
    ttlMs: SCRIPT_WALL_MS + TOKEN_MARGIN_MS,
  });
  let outcome: Awaited<ReturnType<typeof runScript>>;
  try {
    outcome = await runScript({
      script: schedule.script,
      projectId: resolvedProjectId,
      params: schedule.params ?? null,
      limits: { wallMs: SCRIPT_WALL_MS, memoryMb: SCRIPT_MEMORY_MB, logChars: MAX_OUTPUT_CHARS },
      read: reader.read,
    });
  } finally {
    await reader.close();
  }
  const record = { runAs: owner?.userId ?? null, reads: reader.reads() };

  for (const n of outcome.notifications) {
    try {
      await schedulesPorts().emitNotification({
        userId,
        projectId: resolvedProjectId,
        type: 'schedule_report',
        title: n.title,
        body: n.body ?? null,
        scheduleRunId: fireId,
      });
    } catch (err) {
      logger.error(
        { err, scheduleId: schedule.id, fireId },
        'schedule.dispatch: schedule_report notification delivery failed',
      );
    }
  }

  const output = truncate(outcome.output);
  if (outcome.status === 'failed') {
    const error = outcome.error
      ? `${outcome.error.name}: ${outcome.error.message}`
      : 'the script failed';
    return {
      result: { ok: false, reason: 'session-failed', status: 'failed' },
      settle: { status: 'failed', error, output, ...record },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: 'success', resolvedProjectId },
    settle: { status: 'success', output, ...record },
  };
}
