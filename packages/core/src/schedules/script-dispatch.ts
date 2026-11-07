// A script-kind schedule's fire (ISS-618): the script runs in the script sandbox (REQ-37), which a
// chat computation runs in too, and no agent session is started (REQ-87 BC-4). ctx.log and
// ctx.notify are as they were (BC-10); ctx.forge.get reads the run's project as the person the fire
// acts for (whoever pressed run, else the schedule's owner), and the fire records who that was and
// every read it made with its status (BC-9). A schedule that declares ops calls (REQ-87 BC-1) has
// them checked read-only before the script runs at all; a declaration that is not read-only fails
// the fire by name with nothing run. ctx.feedback.file files on the schedule's own project (BC-2),
// and ctx.state is what the last successful firing left (BC-3), written back only when this one
// succeeds. Every call, filing and state change is recorded on the fire.

import { type ScriptOpsDeclaration, scriptOpsSchema } from '@forge/contracts/script-sandbox';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { openForgeReader, runScript } from '../sandbox/index.js';
import type { DispatchScheduleInput, RoutedFire } from './dispatch-types.js';
import { schedulesPorts } from './ports.js';
import { resolveScheduleTargetProject } from './release-batch-dispatch.js';
import { scheduledAsker } from './scheduled-session.js';
import { openFiler } from './script-feedback.js';
import { openOpsCaller, opsRefusals } from './script-ops.js';

const SCRIPT_WALL_MS = 30_000;
const SCRIPT_MEMORY_MB = 64;
const MAX_OUTPUT_CHARS = 16_000;
/** How long past the run's wall cap its read token lives, so it never outlives the run by more. */
const TOKEN_MARGIN_MS = 5_000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

/** The schedule's declaration and state as they stand now, read at the fire. */
async function doorsOf(
  scheduleId: string,
): Promise<{ ops: unknown; state: Record<string, unknown> | null }> {
  const [row] = await db
    .select({ ops: schedules.ops, state: schedules.scriptState })
    .from(schedules)
    .where(eq(schedules.id, scheduleId))
    .limit(1);
  return { ops: row?.ops ?? null, state: row?.state ?? null };
}

export async function routeScheduleScriptFire(
  input: DispatchScheduleInput,
  fireId: string,
): Promise<RoutedFire> {
  const { schedule } = input;

  if (!schedule.script) {
    const error = 'this script-kind schedule has no script';
    return {
      result: { ok: false, reason: 'run-failed', status: 'failed', error },
      settle: { status: 'failed', error },
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

  // the declaration is checked before anything runs: a call that is not read-only fails the fire by name
  const doors = await doorsOf(schedule.id);
  let decl: ScriptOpsDeclaration | null = null;
  if (doors.ops !== null) {
    const parsed = scriptOpsSchema.safeParse(doors.ops);
    const refusals = parsed.success
      ? opsRefusals(parsed.data)
      : [
          {
            code: 'SCRIPT_OPS_NOT_READ_ONLY' as const,
            detail: `SCRIPT_OPS_NOT_READ_ONLY: the schedule's ops declaration does not read as one (${parsed.error.issues[0]?.message ?? 'malformed'}); save it again`,
          },
        ];
    if (refusals.length > 0) {
      const error = `the script did not run: ${refusals.map((r) => r.detail).join('; ')}`;
      return {
        result: { ok: false, reason: 'run-failed', status: 'failed', error },
        settle: {
          status: 'failed',
          error,
          refusal: refusals[0]?.code ?? 'SCRIPT_OPS_NOT_READ_ONLY',
          opsCalls: [],
          filings: [],
          stateAfter: null,
        },
      };
    }
    if (parsed.success) decl = parsed.data;
  }

  const owner = scheduledAsker(input.actor, schedule.ownerId);
  const reader = openForgeReader({
    projectId: resolvedProjectId,
    owner,
    ttlMs: SCRIPT_WALL_MS + TOKEN_MARGIN_MS,
  });
  // ops and filings reach the schedule's own project, never a target another slug names
  const ops = openOpsCaller({ projectId: schedule.projectId, decl });
  const filer = openFiler({
    projectId: schedule.projectId,
    schedule: { id: schedule.id, name: schedule.name ?? 'script schedule' },
    fireId,
  });
  let outcome: Awaited<ReturnType<typeof runScript>>;
  try {
    outcome = await runScript({
      script: schedule.script,
      projectId: resolvedProjectId,
      params: schedule.params ?? null,
      limits: { wallMs: SCRIPT_WALL_MS, memoryMb: SCRIPT_MEMORY_MB, logChars: MAX_OUTPUT_CHARS },
      read: reader.read,
      ops: { names: ops.names, call: ops.call },
      file: filer.file,
      state: doors.state ?? {},
    });
  } finally {
    await reader.close();
  }

  // a failed firing leaves the state as the last good one did, so a half-run never confirms a breach
  const stateAfter = outcome.status === 'success' ? outcome.state : null;
  if (stateAfter !== null) {
    await db
      .update(schedules)
      .set({ scriptState: stateAfter })
      .where(eq(schedules.id, schedule.id));
  }
  const record = {
    runAs: owner?.userId ?? null,
    reads: reader.reads(),
    opsCalls: ops.calls(),
    filings: filer.filings(),
    stateAfter,
  };

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
      result: { ok: false, reason: 'run-failed', status: 'failed', error },
      settle: { status: 'failed', error, output, ...record },
    };
  }
  return {
    result: { ok: true, sessionId: null, status: 'success', resolvedProjectId },
    settle: { status: 'success', output, ...record },
  };
}
