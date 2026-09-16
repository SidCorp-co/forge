/**
 * The `runner:sessions` frame: a box telling core its whole session registry.
 */

import type { WebSocket } from 'ws';
import { z } from 'zod';
import { logger } from '../logger.js';
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

const snapshotSchema = z
  .object({
    bootId: z.string().min(1).max(120),
    runs: z.array(runSchema).max(64),
  })
  .strict();

/**
 * Store one box's snapshot, or drop it and say why.
 */
export async function handleRunnerSessions(ws: LedgerWs, msg: unknown): Promise<void> {
  const deviceId = ws.principal?.type === 'device' ? ws.principal.deviceId : undefined;
  if (!deviceId) {
    logger.warn('runner:sessions from non-device principal');
    return;
  }
  const parsed = snapshotSchema.safeParse((msg as { data?: unknown })?.data);
  if (!parsed.success) {
    logger.warn({ err: parsed.error.message, deviceId }, 'runner:sessions invalid payload');
    return;
  }
  try {
    await applyRunLedgerSnapshot({
      deviceId,
      entries: parsed.data.runs.map((r) => ({
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
