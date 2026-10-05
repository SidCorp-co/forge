/**
 * One box's session registry, as core stores it (ISS-934).
 *
 * The box is the authority on what it is running; this is a mirror with a time
 * on it. Applying a snapshot is therefore a REPLACE for that device and not a
 * merge — the box has just said what it holds, and anything else core had for
 * it is stale by construction.
 */

import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, runners } from '../db/schema.js';
import { deviceRunLedger } from '../db/schema-run-ledger.js';
import { logger } from '../lib/logger.js';

interface RunLedgerIssue {
  issueKey: string;
  leaseReturned: boolean;
}

interface RunLedgerEntry {
  runId: string;
  projectId: string;
  sessionId: string | null;
  masterSessionId: string | null;
  pid: number | null;
  worktreePath: string;
  bootId: string;
  incarnation: string;
  work: string;
  blockerKind: string | null;
  waitingOn: string | null;
  /** Epoch SECONDS, which is the unit the box's ledger stamps. */
  sessionTerminalAtEpochS: number | null;
  worktreeGoneAtEpochS: number | null;
  issues: RunLedgerIssue[];
}

const fromEpochSeconds = (s: number | null | undefined): Date | null =>
  s == null ? null : new Date(s * 1000);

export async function applyRunLedgerSnapshot(args: {
  deviceId: string;
  entries: RunLedgerEntry[];
  /** Runs the box still reports but core refused this frame: their rows stand as they were. */
  keep?: readonly string[];
}): Promise<void> {
  const claimed = [...new Set(args.entries.map((e) => e.projectId))];
  const bound = new Set(
    claimed.length === 0
      ? []
      : (
          await db
            .select({ projectId: runners.projectId })
            .from(runners)
            .where(and(eq(runners.deviceId, args.deviceId), inArray(runners.projectId, claimed)))
        ).map((r) => r.projectId),
  );
  const entries = args.entries.filter((e) => {
    if (bound.has(e.projectId)) return true;
    logger.warn(
      { deviceId: args.deviceId, runId: e.runId, projectId: e.projectId },
      'run-ledger: run named a project this device is not bound to — dropped',
    );
    return false;
  });

  // A box reporting its parent is corroboration, never the record: the record
  // is `agent_sessions.parent_session_id`, which core writes when it opens the
  // child. A reported master core never issued — or one that is a master of
  // another box — is refused here and named, and the run itself is still stored,
  // because losing the observation would cost an operator the whole row rather
  // than one edge of it (ISS-1136).
  const reported = [...new Set(entries.map((e) => e.masterSessionId).filter((id) => id != null))];
  const issued = new Set(
    reported.length === 0
      ? []
      : (
          await db
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(
              and(
                inArray(agentSessions.id, reported),
                eq(agentSessions.kind, MASTER_SESSION_KIND),
                eq(agentSessions.deviceId, args.deviceId),
              ),
            )
        ).map((r) => r.id),
  );
  for (const e of entries) {
    if (e.masterSessionId != null && !issued.has(e.masterSessionId)) {
      logger.warn(
        {
          deviceId: args.deviceId,
          runId: e.runId,
          projectId: e.projectId,
          reportedMasterSessionId: e.masterSessionId,
        },
        'run-ledger: this box reported a master core did not issue on it — the owner edge was refused, the run is still recorded',
      );
    }
  }

  const observedAt = new Date();
  await db.transaction(async (tx) => {
    const keep = [...entries.map((e) => e.runId), ...(args.keep ?? [])];
    await tx
      .delete(deviceRunLedger)
      .where(
        keep.length === 0
          ? eq(deviceRunLedger.deviceId, args.deviceId)
          : and(
              eq(deviceRunLedger.deviceId, args.deviceId),
              notInArray(deviceRunLedger.runId, keep),
            ),
      );
    for (const {
      runId,
      masterSessionId,
      sessionTerminalAtEpochS,
      worktreeGoneAtEpochS,
      ...e
    } of entries) {
      const values = {
        ...e,
        masterSessionId:
          masterSessionId != null && issued.has(masterSessionId) ? masterSessionId : null,
        sessionTerminalAt: fromEpochSeconds(sessionTerminalAtEpochS),
        worktreeGoneAt: fromEpochSeconds(worktreeGoneAtEpochS),
        observedAt,
      };
      await tx
        .insert(deviceRunLedger)
        .values({ deviceId: args.deviceId, runId, ...values })
        .onConflictDoUpdate({
          target: [deviceRunLedger.deviceId, deviceRunLedger.runId],
          set: values,
        });
    }
  });
  logger.debug({ deviceId: args.deviceId, runs: entries.length }, 'run-ledger: snapshot applied');
}
