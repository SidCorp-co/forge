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

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/session_ledger.rs — `RunEntry` serializes to exactly this shape; nothing type-checks the pair, so a field renamed on one side is dropped in silence on the other.
// cm:guard `.strict()` on the run, so a field the box invents is a REFUSAL rather than a silent drop. This is a mirror of another process's state and the two versions drift on their own release clocks; a snapshot core half-understands is worse than one it rejects loudly.
const runSchema = z
  .object({
    runId: z.string().min(1).max(120),
    projectId: z.uuid(),
    sessionId: z.uuid().nullish(),
    masterSessionId: z.uuid().nullish(),
    pid: z.number().int().positive().nullish(),
    worktreePath: z.string().min(1).max(1024),
    bootId: z.string().min(1).max(120),
    incarnation: z.enum(['live', 'exited']),
    work: z.enum(['runnable', 'blocked', 'done']),
    blockerKind: z.enum(['machine', 'master_or_peer', 'human', 'nobody']).nullish(),
    waitingOn: z.string().max(1024).nullish(),
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
// cm:guard a DEVICE principal only. A user socket carries its owner's account authority, so accepting this from one would let any signed-in person rewrite what a box is running — and the read surface below presents it as the box's own word.
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
        waitingOn: r.waitingOn ?? null,
        issues: r.issues,
      })),
    });
  } catch (err) {
    logger.error({ err, deviceId }, 'runner:sessions could not be stored');
  }
}
