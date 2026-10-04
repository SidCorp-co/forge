import {
  type AgentSessionStatus,
  SESSION_MACHINE,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { eq } from 'drizzle-orm';
import { agentSessions } from '../db/schema.js';
import {
  type KernelExecutor,
  type TransitionArgs,
  type TransitionResult,
  transition,
} from '../lifecycle/transition.js';
import type { MachineRow } from '../lifecycle/machine-tables.js';
import { logger } from '../logger.js';
import { settleSessionFires } from '../schedules/fires.js';
import { RUN_SESSION_KIND } from '../jobs/session-kinds.js';
import { fireTerminalSessionBridges, sessionCarriesBridgeMarker } from './terminal-effects.js';

type SessionRow = MachineRow<'session'>;

/** What a bulk session sweep reads off each row it flips: the ids the broadcast needs, the run the
 *  wedge looks its issue up through, and the status the row landed on. */
export const SWEEP_SESSION_COLUMNS = [
  'id',
  'projectId',
  'deviceId',
  'pipelineRunId',
  'status',
] as const satisfies ReadonlyArray<keyof SessionRow>;

const ENDED: readonly AgentSessionStatus[] = TERMINAL_AGENT_SESSION_STATUSES;

/**
 * A session's status move: the kernel transition on the session machine, and, once a session has
 * ended, what its end owes: the schedule fire it started settles in the same transaction, a run
 * session hands back every issue it left `in_progress` with nothing holding it, a bridge-marked
 * session delivers its completion, and a session closes what it owns.
 */
export async function transitionSessions<K extends keyof SessionRow = keyof SessionRow>(
  exec: KernelExecutor,
  args: TransitionArgs<'session', K>,
): Promise<TransitionResult<Pick<SessionRow, K | 'id'>> & { returned: string[] }> {
  const ending = ENDED.includes(args.to);
  const returning =
    ending && args.returning
      ? ([...args.returning, 'metadata', 'kind', 'pipelineRunId'] as K[])
      : args.returning;
  const result = await transition(exec, SESSION_MACHINE, {
    ...args,
    ...(returning ? { returning } : {}),
    afterWrite: async (tx, rows) => {
      await args.afterWrite?.(tx, rows);
      if (ending) {
        await settleSessionFires(tx, {
          sessionIds: rows.map((r) => r.id),
          sessionStatus: args.to,
          actor: args.actor,
          source: args.source,
        });
      }
    },
  });
  let returned: string[] = [];
  if (ending && result.rows.length > 0) {
    returned = await handBackRunIssues(result.rows, args);
    await fireSessionBridges(exec, result.rows, args.returning === undefined);
    await descendFrom(
      result.rows.map((r) => r.id),
      args,
    );
  }
  return { ...result, returned };
}

/**
 * The kernel's hand-back (workflow `issue-lifecycle` rev 8): a run that ended, whatever its outcome,
 * returns each issue it still has at `in_progress`, held by nothing else, to the status it took it
 * from, along the issue machine's recovery edges. A failure is logged and never thrown: the session
 * has ended either way. Answers the keys of the issues handed back.
 */
async function handBackRunIssues(
  rows: ReadonlyArray<{ id: string }>,
  args: { to: string; source: string; reason?: string | null | undefined },
): Promise<string[]> {
  const runs = new Set<string>();
  for (const row of rows) {
    const { kind, pipelineRunId } = row as Partial<Pick<SessionRow, 'kind' | 'pipelineRunId'>>;
    if (kind === RUN_SESSION_KIND && pipelineRunId) runs.add(pipelineRunId);
  }
  if (runs.size === 0) return [];
  const { returnIssuesForRun } = await import('../devices/run-issue-return.js');
  const returned: string[] = [];
  for (const runId of runs) {
    try {
      const back = await returnIssuesForRun(runId, {
        reason: `its run session ended ${args.to} (${args.reason ?? args.source})`,
      });
      returned.push(...back.map((r) => r.issueKey));
    } catch (err) {
      logger.error(
        { err, runId, source: args.source },
        'session-transition: an ended run session could not hand its issues back; they stay at in_progress until the next end of a session over them',
      );
    }
  }
  return returned;
}

/** A flip the descent itself wrote is skipped: the walk owns its depth bound. */
async function descendFrom(
  ids: string[],
  args: { to: string; source: string; reason?: string | null | undefined },
): Promise<void> {
  const { closeSessionsOwnedBy, DESCENT_SOURCE } = await import('./session-descent.js');
  if (args.source === DESCENT_SOURCE) return;
  try {
    await closeSessionsOwnedBy(ids, {
      reason: 'owner_session_closed',
      detail: `session-descent: the session that owned this one went ${args.to} (${args.reason ?? args.source})`,
    });
  } catch (err) {
    logger.error(
      { err, sessionIds: ids, source: args.source },
      'session-transition: an ended session could not close what it owned; rows beneath it are still open',
    );
  }
}

async function fireSessionBridges(
  exec: KernelExecutor,
  rows: ReadonlyArray<{ id: string }>,
  whole: boolean,
): Promise<void> {
  for (const row of rows) {
    if (!sessionCarriesBridgeMarker((row as { metadata?: unknown }).metadata)) continue;
    const full = whole ? (row as SessionRow) : await hydrateSession(exec, row.id);
    if (full) void fireTerminalSessionBridges(full);
  }
}

async function hydrateSession(exec: KernelExecutor, sessionId: string): Promise<SessionRow | null> {
  try {
    const [row] = await exec
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (row) return row;
    logger.error(
      { sessionId },
      'session-transition: a bridge-marked session could not be re-read after its flip; its completion reply was not delivered',
    );
  } catch (err) {
    logger.error(
      { err, sessionId },
      'session-transition: re-reading a bridge-marked session after its flip failed; its completion reply was not delivered',
    );
  }
  return null;
}
