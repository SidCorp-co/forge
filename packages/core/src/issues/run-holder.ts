// Which runs hold one issue now, and the box each was declared from: the one reading behind every
// move the issue machine gives "the run holding the issue". A run holds an issue two ways: the fleet
// lease a run session takes (`issue_leases`, read live through `liveIssueLeasesSql`), and the lease
// on the issue's work state a master's claim writes for the run it declares (`issue_work_state.lease`).
// Reading only the first refused a declared run its own moves (adminhub-api ISS-8, 2026-10-23).

import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { liveIssueLeasesSql } from '../db/schema-issue-leases.js';
import { issueWorkState } from '../db/schema-issue-work-state.js';
import type { CallerBox } from './caller-box.js';
import { classifyLease, leaseHolderOf } from './session-claim.js';

export type RunHolder =
  | { kind: 'run-session'; deviceId: string; sessionId: string; runId: string }
  | { kind: 'declared-run'; holder: string; deviceId: string | null; expiresAt: string | null };

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

/** Every run holding the issue now: live run sessions' fleet leases, then a live declared lease. */
export async function runHoldersOf(
  executor: Pick<Tx, 'select' | 'execute'>,
  issue: { id: string },
  now: Date = new Date(),
): Promise<RunHolder[]> {
  const sessions = (await executor.execute(sql`
    SELECT l.device_id, l.session_id, l.run_id
      FROM ${liveIssueLeasesSql()} l
      JOIN issues i ON i.project_id = l.project_id AND l.issue_key = 'ISS-' || i.iss_seq
     WHERE i.id = ${issue.id}
  `)) as unknown as Array<{ device_id: string; session_id: string; run_id: string }>;
  const holders: RunHolder[] = sessions.map((s) => ({
    kind: 'run-session',
    deviceId: s.device_id,
    sessionId: s.session_id,
    runId: s.run_id,
  }));
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
    .select({ lease: issueWorkState.lease, deviceId: issueWorkState.leaseDeviceId })
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
  };
}

/** How a refusal names a holder. */
export function holderSentence(h: RunHolder): string {
  if (h.kind === 'run-session') return `run session ${h.sessionId} on device ${h.deviceId}`;
  const from = h.deviceId ? `from device ${h.deviceId}` : 'from no paired box';
  return `run \`${h.holder}\`, declared ${from} (its lease runs to ${h.expiresAt})`;
}

/** Whether `caller` is the box of one of `holders`. */
export function callerHolds(holders: readonly RunHolder[], caller: string | null): boolean {
  return caller !== null && holders.some((h) => h.deviceId === caller);
}
