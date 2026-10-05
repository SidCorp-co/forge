/**
 * The `runner:sessions` frame: a box telling core its whole session registry.
 */

import type { WebSocket } from 'ws';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { applyRunLedgerSnapshot } from './run-ledger.js';

interface LedgerWs extends WebSocket {
  principal?: { type: 'user' | 'device'; deviceId?: string };
}

const runSchema = z
  .object({
    runId: z.string().min(1).max(120),
    projectId: z.uuid(),
    sessionId: z.uuid().nullish(),
    masterSessionId: z.uuid().nullish(),
    pid: z.number().int().positive().nullish(),
    worktreePath: z.string().min(1).max(1024),
    bootId: z.string().min(1).max(120),
    incarnation: z.enum(['live', 'starting', 'exited']),
    work: z.enum(['runnable', 'blocked', 'done']),
    blockerKind: z.enum(['machine', 'master_or_peer', 'human', 'nobody']).nullish(),
    waitingOn: z.string().max(1024).nullish(),
    sessionTerminalAtEpochS: z.number().int().nonnegative().nullish(),
    worktreeGoneAtEpochS: z.number().int().nonnegative().nullish(),
    issues: z
      .array(z.object({ issueKey: z.string().min(1).max(64), leaseReturned: z.boolean() }).strict())
      .max(64),
  })
  .strict();

/** A runner registry larger than this is refused whole, by name, rather than stored in part. */
const RUNS_PER_FRAME_MAX = 512;

/**
 * The frame's envelope. Each run is read on its own, so one bad run refuses only itself. A
 * top-level `bootId` is still accepted from builds that send it and is not read: each run carries
 * its own.
 */
const snapshotSchema = z
  .object({
    bootId: z.string().min(1).max(120).optional(),
    runs: z.array(z.unknown()).max(RUNS_PER_FRAME_MAX),
  })
  .strict();

export const RUNNER_SESSIONS_REFUSED_EVENT = 'runner:sessions.refused';

type RunRefusal = { runId: string | null; path: string; detail: string };

function refusalsOf(at: string, runId: string | null, error: z.ZodError): RunRefusal[] {
  return error.issues.map((i) => ({
    runId,
    path: `${at}/${i.path.join('/')}`,
    detail: i.message,
  }));
}

function runIdOf(raw: unknown): string | null {
  const id = (raw as { runId?: unknown } | null)?.runId;
  return typeof id === 'string' ? id : null;
}

/** The box is told by name what was not stored, so it stops resending the same frame blind. */
function tellRefused(ws: LedgerWs, refused: readonly RunRefusal[]): void {
  try {
    ws.send(
      JSON.stringify({
        event: RUNNER_SESSIONS_REFUSED_EVENT,
        data: { refused },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {}
}

/**
 * Store one box's snapshot. A run the schema refuses is named back to the box and its stored row
 * is left as it stood, never deleted as if the run were gone; its `observed_at` stops advancing,
 * which is how a reader tells it from a current one. The runs that parse are stored.
 */
export async function handleRunnerSessions(ws: LedgerWs, msg: unknown): Promise<void> {
  const deviceId = ws.principal?.type === 'device' ? ws.principal.deviceId : undefined;
  if (!deviceId) {
    logger.warn('runner:sessions from non-device principal');
    return;
  }
  const parsed = snapshotSchema.safeParse((msg as { data?: unknown })?.data);
  if (!parsed.success) {
    const refused = refusalsOf('/data', null, parsed.error);
    logger.warn({ deviceId, refused }, 'runner:sessions frame refused whole');
    tellRefused(ws, refused);
    return;
  }
  const runs: z.infer<typeof runSchema>[] = [];
  const refused: RunRefusal[] = [];
  const frozen: string[] = [];
  parsed.data.runs.forEach((raw, at) => {
    const run = runSchema.safeParse(raw);
    if (run.success) {
      runs.push(run.data);
      return;
    }
    const runId = runIdOf(raw);
    if (runId) frozen.push(runId);
    refused.push(...refusalsOf(`/data/runs/${at}`, runId, run.error));
  });
  if (refused.length > 0) {
    logger.warn({ deviceId, refused }, 'runner:sessions runs refused — the rest stored');
    tellRefused(ws, refused);
  }
  try {
    await applyRunLedgerSnapshot({
      deviceId,
      keep: frozen,
      entries: runs.map((r) => ({
        runId: r.runId,
        projectId: r.projectId,
        sessionId: r.sessionId ?? null,
        masterSessionId: r.masterSessionId ?? null,
        pid: r.pid ?? null,
        worktreePath: r.worktreePath,
        bootId: r.bootId,
        incarnation: r.incarnation,
        work: r.work,
        blockerKind: r.blockerKind ?? null,
        sessionTerminalAtEpochS: r.sessionTerminalAtEpochS ?? null,
        worktreeGoneAtEpochS: r.worktreeGoneAtEpochS ?? null,
        waitingOn: r.waitingOn ?? null,
        issues: r.issues,
      })),
    });
  } catch (err) {
    logger.error({ err, deviceId }, 'runner:sessions could not be stored');
  }
}
