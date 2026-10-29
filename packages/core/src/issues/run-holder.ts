// Which runs hold one issue now, and the box each was declared from: the one reading behind every
// move the issue machine gives "the run holding the issue". A run holds an issue three ways: the fleet
// lease a run session takes (`issue_leases`, read live through `liveIssueLeasesSql`), a live run
// session declared over the issue while it was over, which took no lease (ISS-589), and the lease
// on the issue's work state a master's claim writes for the run it declares (`issue_work_state.lease`).
// Reading only the first refused a declared run its own moves (adminhub-api ISS-8, 2026-10-23). The
// moves into in_progress and awaiting_release both ask `callerHolds` over this reading (ISS-589 r2).

import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { liveIssueLeasesSql } from '../db/schema-issue-leases.js';
import { issueWorkState } from '../db/schema-issue-work-state.js';
import type { CallerBox } from './caller-box.js';
import { runSessionsDeclaredOverSql } from './issue-lease.js';
import { classifyLease, leaseHolderOf } from './session-claim.js';

export type RunHolder =
  | { kind: 'run-session'; deviceId: string; sessionId: string; runId: string }
  | {
      kind: 'declared-run';
      holder: string;
      deviceId: string | null;
      expiresAt: string | null;
      /** The token that wrote the lease, which names its holder where no box does; never shown. */
      tokenId: string | null;
    };

/**
 * The box a lease write is stored with (`issue_work_state.lease_device_id`, `lease_token_id`): a
 * write that keeps the holder keeps the box the holder was declared from, so a person shortening a
 * run's lease leaves the run its holder; a write naming a new holder records the writer's box. The
 * blob is forge-plugin's and never carries it: the plugin reads its lease back and compares.
 */
export function leaseOriginFor(
  prior: { lease: unknown; origin: CallerBox | null },
  next: unknown,
  writer: CallerBox,
): CallerBox {
  const holder = leaseHolderOf(next);
  const keeps = holder !== null && holder === leaseHolderOf(prior.lease);
  return keeps && prior.origin?.deviceId ? prior.origin : writer;
}

/**
 * The run sessions holding the issue now: a live session's fleet lease, and a live session declared
 * over the issue that took none because the issue was over when it opened (ISS-589), one row per
 * session. `exceptRunId` leaves out the run handing the issue back.
 */
export async function runSessionHoldersOf(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
  exceptRunId: string | null = null,
): Promise<Array<Extract<RunHolder, { kind: 'run-session' }>>> {
  const notThatRun =
    exceptRunId === null ? sql`` : sql` AND l.run_id IS DISTINCT FROM ${exceptRunId}`;
  const sessions = (await executor.execute(sql`
    SELECT l.device_id, l.session_id, l.run_id
      FROM ${liveIssueLeasesSql()} l
      JOIN issues i ON i.project_id = l.project_id AND l.issue_key = 'ISS-' || i.iss_seq
     WHERE i.id = ${issueId}${notThatRun}
    UNION
    SELECT d.device_id, d.session_id, d.run_id
      FROM issues i
     CROSS JOIN LATERAL ${runSessionsDeclaredOverSql({
       projectId: sql`i.project_id`,
       issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
       exceptRunId,
     })} d
     WHERE i.id = ${issueId}
     ORDER BY session_id
  `)) as unknown as Array<{ device_id: string; session_id: string; run_id: string }>;
  return sessions.map((s) => ({
    kind: 'run-session',
    deviceId: s.device_id,
    sessionId: s.session_id,
    runId: s.run_id,
  }));
}

/** Every run holding the issue now: live run sessions, then a live declared lease. */
export async function runHoldersOf(
  executor: Pick<Tx, 'select' | 'execute'>,
  issue: { id: string },
  now: Date = new Date(),
): Promise<RunHolder[]> {
  const holders: RunHolder[] = await runSessionHoldersOf(executor, issue.id);
  const declared = await declaredRunOf(executor, issue.id, now);
  return declared ? [...holders, declared] : holders;
}

/** The run a live lease on the issue's work state holds it for, or null. */
export async function declaredRunOf(
  executor: Pick<Tx, 'select'>,
  issueId: string,
  now: Date = new Date(),
): Promise<Extract<RunHolder, { kind: 'declared-run' }> | null> {
  const [row] = await executor
    .select({
      lease: issueWorkState.lease,
      deviceId: issueWorkState.leaseDeviceId,
      tokenId: issueWorkState.leaseTokenId,
    })
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .limit(1);
  const lease = row?.lease ?? null;
  const reading = classifyLease({ lease, now, fanout: 1 });
  if ((reading.verdict !== 'live' && reading.verdict !== 'shared') || !reading.holder) return null;
  return {
    kind: 'declared-run',
    holder: reading.holder,
    deviceId: row?.deviceId ?? null,
    expiresAt: reading.expiresAt?.toISOString() ?? null,
    tokenId: row?.tokenId ?? null,
  };
}

/** How a refusal names a holder. */
export function holderSentence(h: RunHolder): string {
  if (h.kind === 'run-session') return `run session ${h.sessionId} on device ${h.deviceId}`;
  const from = h.deviceId ? `from device ${h.deviceId}` : 'from no paired box';
  return `run \`${h.holder}\`, declared ${from} (its lease runs to ${h.expiresAt})`;
}

/** A holder as a refusal's details carry it: the lease's token stays inside core. */
export function holderShown(h: RunHolder): Record<string, unknown> {
  if (h.kind === 'run-session') return h;
  const { tokenId: _kept, ...shown } = h;
  return shown;
}

/**
 * Whether `caller` holds the issue among `holders`: it is the box of one, or, for a lease written
 * from no box, the very token that wrote it.
 */
export function callerHolds(holders: readonly RunHolder[], caller: CallerBox | null): boolean {
  if (!caller) return false;
  return holders.some(
    (h) =>
      (caller.deviceId !== null && h.deviceId === caller.deviceId) ||
      (h.kind === 'declared-run' &&
        h.deviceId === null &&
        h.tokenId !== null &&
        h.tokenId === caller.tokenId),
  );
}
