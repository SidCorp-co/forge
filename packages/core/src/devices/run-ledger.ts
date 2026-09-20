/**
 * One box's session registry, as core stores it (ISS-934).
 *
 * The box is the authority on what it is running; this is a mirror with a time
 * on it. Applying a snapshot is therefore a REPLACE for that device and not a
 * merge — the box has just said what it holds, and anything else core had for
 * it is stale by construction.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices, runners } from '../db/schema.js';
import { deviceRunLedger } from '../db/schema-run-ledger.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { logger } from '../logger.js';

export interface RunLedgerIssue {
  issueKey: string;
  leaseReturned: boolean;
}

export interface RunLedgerEntry {
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
  const entries = args.entries.filter((e) => bound.has(e.projectId));
  for (const e of args.entries) {
    if (!bound.has(e.projectId)) {
      logger.warn(
        { deviceId: args.deviceId, runId: e.runId, projectId: e.projectId },
        'run-ledger: run named a project this device is not bound to — dropped',
      );
    }
  }

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
    const keep = entries.map((e) => e.runId);
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
    for (const e of entries) {
      const values = {
        projectId: e.projectId,
        sessionId: e.sessionId,
        masterSessionId:
          e.masterSessionId != null && issued.has(e.masterSessionId) ? e.masterSessionId : null,
        pid: e.pid,
        worktreePath: e.worktreePath,
        bootId: e.bootId,
        incarnation: e.incarnation,
        work: e.work,
        blockerKind: e.blockerKind,
        waitingOn: e.waitingOn,
        sessionTerminalAt: fromEpochSeconds(e.sessionTerminalAtEpochS),
        worktreeGoneAt: fromEpochSeconds(e.worktreeGoneAtEpochS),
        issues: e.issues,
        observedAt,
      };
      await tx
        .insert(deviceRunLedger)
        .values({ deviceId: args.deviceId, runId: e.runId, ...values })
        .onConflictDoUpdate({
          target: [deviceRunLedger.deviceId, deviceRunLedger.runId],
          set: values,
        });
    }
  });
  logger.debug({ deviceId: args.deviceId, runs: entries.length }, 'run-ledger: snapshot applied');
}

export interface ProjectRunSessionRow
  extends Omit<RunLedgerEntry, 'sessionTerminalAtEpochS' | 'worktreeGoneAtEpochS'> {
  /** ISO, because this half is read by a browser rather than written by a box. */
  sessionTerminalAt: string | null;
  worktreeGoneAt: string | null;
  deviceId: string;
  deviceName: string | null;
  observedAt: string;
  /** Core's own reading of the session, never the box's claim. */
  sessionStatus: string | null;
  /** Why core failed the session, where it did. `null` both on a clean end and on a session that
   *  has not ended — `sessionStatus` is what separates those two, never this field's absence. */
  sessionFailureReason: string | null;
  lastActivityAt: string | null;
  masterTitle: string | null;
}

/** Every run the fleet has reported for one project, newest report first. */
export async function readProjectRunSessions(projectId: string): Promise<ProjectRunSessionRow[]> {
  const rows = await db
    .select({
      deviceId: deviceRunLedger.deviceId,
      runId: deviceRunLedger.runId,
      projectId: deviceRunLedger.projectId,
      sessionId: deviceRunLedger.sessionId,
      masterSessionId: deviceRunLedger.masterSessionId,
      pid: deviceRunLedger.pid,
      worktreePath: deviceRunLedger.worktreePath,
      bootId: deviceRunLedger.bootId,
      incarnation: deviceRunLedger.incarnation,
      work: deviceRunLedger.work,
      blockerKind: deviceRunLedger.blockerKind,
      waitingOn: deviceRunLedger.waitingOn,
      sessionTerminalAt: deviceRunLedger.sessionTerminalAt,
      worktreeGoneAt: deviceRunLedger.worktreeGoneAt,
      issues: deviceRunLedger.issues,
      observedAt: deviceRunLedger.observedAt,
      deviceName: devices.name,
      sessionStatus: sql<
        string | null
      >`(SELECT s.status FROM agent_sessions s WHERE s.id = ${deviceRunLedger.sessionId})`,
      sessionFailureReason: sql<
        string | null
      >`(SELECT s.failure_reason FROM agent_sessions s WHERE s.id = ${deviceRunLedger.sessionId})`,
      lastActivityAt: sql<
        string | null
      >`(SELECT s.last_heartbeat_at FROM agent_sessions s WHERE s.id = ${deviceRunLedger.sessionId})`,
      masterTitle: sql<
        string | null
      >`(SELECT s.title FROM agent_sessions s WHERE s.id = ${deviceRunLedger.masterSessionId})`,
    })
    .from(deviceRunLedger)
    .leftJoin(devices, eq(devices.id, deviceRunLedger.deviceId))
    .where(eq(deviceRunLedger.projectId, projectId))
    .orderBy(sql`${deviceRunLedger.observedAt} DESC`);
  return rows.map((r) => ({
    ...r,
    issues: (r.issues ?? []) as RunLedgerIssue[],
    observedAt: new Date(r.observedAt).toISOString(),
    lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
    sessionTerminalAt: r.sessionTerminalAt ? new Date(r.sessionTerminalAt).toISOString() : null,
    worktreeGoneAt: r.worktreeGoneAt ? new Date(r.worktreeGoneAt).toISOString() : null,
  }));
}
