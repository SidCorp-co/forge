import { RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import {
  type AgentSessionStatus,
  CANCELLED_AGENT_SESSION_STATUSES,
  LIVE_SESSION_STATUSES,
  SESSION_MACHINE,
  TERMINAL_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterCommit, db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import type { MachineRow } from '../lifecycle/index.js';
import {
  type KernelExecutor,
  type TransitionArgs,
  type TransitionResult,
  transition,
} from '../lifecycle/index.js';
import { assertRunAcceptsWork } from '../pipeline/index.js';
import { agentSessionsPorts } from './ports.js';
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

const CANCEL_REASONS: readonly string[] = ['user_cancelled', 'pipeline_cancelled'];

/** A session end that stops the run on purpose (agent-run-standing, `cancelled`). */
function isCancelEnd(args: { to: string; reason?: string | null }): boolean {
  return (
    CANCELLED_AGENT_SESSION_STATUSES.includes(args.to as AgentSessionStatus) ||
    CANCEL_REASONS.includes(args.reason ?? '')
  );
}

/**
 * A session's status move: the kernel transition on the session machine, and, once a session has
 * ended, what its end owes: the schedule fire it started settles in the same transaction, a run
 * session hands back every issue it left `in_progress` with nothing holding it, a bridge-marked
 * session delivers its completion, and a session closes what it owns.
 *
 * The hand-back is written as owed in the flip's own transaction and done only once that write
 * has committed: on `db`, on return, here; inside a caller's transaction, by an after-commit hook
 * on it, or by the caller over `owedHandBacks` when it passes `handBack: 'caller'` because it
 * answers the keys. A close that rolls back takes the owed mark with it and runs no hook, so the
 * issues stay where they stood (VISION: state-never-lies); a hand-back that fails after the
 * commit stays owed for the `run-hand-back-retry` sweep.
 */
export async function transitionSessions<K extends keyof SessionRow = keyof SessionRow>(
  exec: KernelExecutor,
  args: TransitionArgs<'session', K>,
  opts: { handBack?: 'after-commit' | 'caller' } = {},
): Promise<
  TransitionResult<Pick<SessionRow, K | 'id'>> & { returned: string[]; owedHandBacks: string[] }
> {
  const ending = ENDED.includes(args.to);
  const returning =
    ending && args.returning
      ? ([...args.returning, 'metadata', 'kind', 'pipelineRunId'] as K[])
      : args.returning;
  const result = await transition(exec, SESSION_MACHINE, {
    ...args,
    ...(returning ? { returning } : {}),
    beforeWrite: async (tx, prior) => {
      // A move into a live status is a write the parent run has to accept (the I1 rule).
      if (LIVE_SESSION_STATUSES.includes(args.to) && prior.length > 0) {
        const runs = await tx
          .selectDistinct({ runId: agentSessions.pipelineRunId })
          .from(agentSessions)
          .where(
            inArray(
              agentSessions.id,
              prior.map((r) => r.id),
            ),
          );
        for (const { runId } of runs) await assertRunAcceptsWork(tx, runId);
      }
      await args.beforeWrite?.(tx, prior);
    },
    afterWrite: async (tx, rows) => {
      await args.afterWrite?.(tx, rows);
      if (ending) {
        await agentSessionsPorts().settleSessionFires(tx, {
          sessionIds: rows.map((r) => r.id),
          sessionStatus: args.to,
          actor: args.actor,
          source: args.source,
        });
        if (isCancelEnd(args) && rows.length > 0) {
          await agentSessionsPorts().voidCancelledRunQuestions(tx, {
            issueId: null,
            sessionIds: rows.map((r) => r.id),
            reason: args.reason ?? args.to,
            actor: args.actor,
            source: args.source,
          });
        }
        const owed = runSessionRuns(rows);
        await markHandBacksOwed(tx, owed);
        if (owed.length > 0 && exec !== db && opts.handBack !== 'caller') {
          afterCommit(() => void settleHandBacks(owed, handBackReason(args)));
        }
      }
    },
  });
  let returned: string[] = [];
  const owedHandBacks = ending ? runSessionRuns(result.rows) : [];
  if (ending && result.rows.length > 0) {
    if (exec === db) {
      returned = await settleHandBacks(owedHandBacks, handBackReason(args));
    }
    await fireSessionBridges(exec, result.rows, args.returning === undefined);
    await descendFrom(
      exec,
      result.rows.map((r) => r.id),
      args,
    );
  }
  return { ...result, returned, owedHandBacks };
}

/** The runs of the run sessions among `rows`: the ones whose end owes a hand-back. */
function runSessionRuns(rows: ReadonlyArray<{ id: string }>): string[] {
  const runs = new Set<string>();
  for (const row of rows) {
    const { kind, pipelineRunId } = row as Partial<Pick<SessionRow, 'kind' | 'pipelineRunId'>>;
    if (kind === RUN_SESSION_KIND && pipelineRunId) runs.add(pipelineRunId);
  }
  return [...runs];
}

function handBackReason(args: { to: string; source: string; reason?: string | null }): string {
  return `its run session ended ${args.to} (${args.reason ?? args.source})`;
}

/** Written in the ending flip's transaction, so the owed hand-back commits or rolls back with it. */
async function markHandBacksOwed(exec: KernelExecutor, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  await exec
    .update(agentSessions)
    .set({
      metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${HAND_BACK_OWED}::text, true)`,
    })
    .where(
      and(inArray(agentSessions.pipelineRunId, runIds), eq(agentSessions.kind, RUN_SESSION_KIND)),
    );
}

/**
 * The kernel's hand-back (workflow `issue-lifecycle` rev 8), run once the end that owes it has
 * committed: each run returns every issue it still has at `in_progress`, held by nothing else, to
 * the status it took it from, along the issue machine's recovery edges, and its owed mark clears.
 * A run whose return fails stays owed for the `run-hand-back-retry` sweep. Answers the keys of
 * the issues handed back.
 */
export async function settleHandBacks(
  runIds: readonly string[],
  reason: string,
): Promise<string[]> {
  if (runIds.length === 0) return [];
  const { returnIssuesForRun } = await import('../devices/index.js');
  const returned: string[] = [];
  for (const runId of runIds) {
    try {
      const back = await returnIssuesForRun(runId, { reason });
      returned.push(...back.map((r) => r.issueKey));
      await db
        .update(agentSessions)
        .set({ metadata: sql`${agentSessions.metadata} - ${HAND_BACK_OWED}` })
        .where(
          and(eq(agentSessions.pipelineRunId, runId), eq(agentSessions.kind, RUN_SESSION_KIND)),
        );
    } catch (err) {
      logger.error(
        { err, runId },
        'session-transition: an ended run session could not hand its issues back; it stays owed for the retry sweep',
      );
    }
  }
  return returned;
}

const HAND_BACK_OWED = 'handBackOwed';

/** Repeats every hand-back an ended run session still owes; a run's mark clears once its return lands. */
export async function retryOwedHandBacks(): Promise<{ owed: number; returned: number }> {
  const owed = await db
    .selectDistinct({ runId: agentSessions.pipelineRunId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.kind, RUN_SESSION_KIND),
        inArray(agentSessions.status, [...ENDED]),
        sql`${agentSessions.metadata} ->> ${HAND_BACK_OWED} = 'true'`,
      ),
    )
    .limit(50);
  const runIds = owed.flatMap(({ runId }) => (runId ? [runId] : []));
  const returned = (await settleHandBacks(runIds, 'its ended run session owed this hand-back'))
    .length;
  return { owed: owed.length, returned };
}

/** A flip the descent itself wrote is skipped: the walk owns its depth bound. */
async function descendFrom(
  exec: KernelExecutor,
  ids: string[],
  args: { to: string; source: string; reason?: string | null | undefined },
): Promise<void> {
  const { closeSessionsOwnedBy, DESCENT_SOURCE } = await import('./session-descent.js');
  if (args.source === DESCENT_SOURCE) return;
  try {
    await closeSessionsOwnedBy(exec, ids, {
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
