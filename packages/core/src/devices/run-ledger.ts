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
import { devices, runners } from '../db/schema.js';
import { deviceRunLedger } from '../db/schema-run-ledger.js';
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
  // cm:guard the unit is in the NAME because it has to be: the box has no date library and stamps `as_secs()`, so this crosses the wire as a bare number. A field called `sessionTerminalAt` carrying seconds is the shape that gets read as milliseconds and dated to 1970 — and a mark 56 years old reads as a mark, so nothing would look wrong (ISS-964 criterion 52).
  sessionTerminalAtEpochS: number | null;
  worktreeGoneAtEpochS: number | null;
  issues: RunLedgerIssue[];
}

// cm:guard the ONE converter, and it is here rather than at each call site so the unit is asserted once. A zero is a real stamp and must not be read as absent, so the check is `== null` and never falsy.
const fromEpochSeconds = (s: number | null | undefined): Date | null =>
  s == null ? null : new Date(s * 1000);

/**
 * Replace everything core holds for one device with what that device just said.
 */
// cm:guard the delete and the upserts are ONE transaction. A snapshot applied in two statements has a window where the device holds nothing, and a reader landing in it reports a working box as idle — the exact wrong answer this surface exists to stop being given.
// cm:guard the delete is scoped to `deviceId` and must stay so: this is the only writer that removes rows it did not just write, and a predicate widened past one device would have one box's snapshot retire another's runs.
// cm:guard the PROJECT on each entry is the box's claim and is checked against that box's own bindings before anything is written. Every paired runner in the fleet holds a valid device token, so an unchecked project id would let any box put a worktree path and a pid into any project's read surface — the same reason `closeMasterSession` refuses to act on a session its caller does not own.
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
        masterSessionId: e.masterSessionId,
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
  lastActivityAt: string | null;
  masterTitle: string | null;
}

/** Every run the fleet has reported for one project, newest report first. */
// cm:guard `lastActivityAt` and `sessionStatus` come from the JOINED `agent_sessions` row and never from the snapshot. A box reporting its own liveness is a box marking its own homework — the heartbeat core already receives is the independent reading, and the two disagreeing is the signal a reader needs (ISS-934 criterion 11).
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
    // cm:guard each mark is `null` when unset and never omitted: a reader deciding whether a diff is still recoverable has to tell "this has not happened" from "the box never reported it", and an absent key reads as the second (ISS-964 criterion 52).
    sessionTerminalAt: r.sessionTerminalAt ? new Date(r.sessionTerminalAt).toISOString() : null,
    worktreeGoneAt: r.worktreeGoneAt ? new Date(r.worktreeGoneAt).toISOString() : null,
  }));
}
