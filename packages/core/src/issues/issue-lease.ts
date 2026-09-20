/**
 * Who is working one issue — asked once, answered once, fleet-wide (ISS-1109).
 *
 * This module is the only writer of `issue_leases` and the only place the SQL
 * for "is this issue being worked" is written. Before it, the same question was
 * asked in four places in three shapes, one of which filtered on the asking
 * device and so told box B that an issue box A was running was free.
 *
 * A lease is taken by a conditional write the primary key can refuse, never by
 * a read followed by a write: `takeIssueLeases` clears rows whose session is
 * already terminal and then inserts with `ON CONFLICT DO NOTHING`, so the loser
 * of a race is told no by Postgres rather than by a check that raced.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { TERMINAL_JOB_STATUSES } from '../jobs/status-sets.js';

/** Statuses a `pipeline_runs` row carries while it is still someone's work. */
const LIVE_PIPELINE_RUN_STATUSES = ['running', 'paused'] as const;

const terminalSessionList = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

const terminalJobList = sql.join(
  TERMINAL_JOB_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const livePipelineRunList = sql.join(
  LIVE_PIPELINE_RUN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * Whether a live run session holds this issue's lease.
 *
 * A lease row alone is not held-ness: the row outlives the box, and a lease
 * nothing can release is how an issue is stranded where no run can take it. So
 * held-ness is the row AND a session that has not reached a terminal status,
 * which is monotone — a terminal session never becomes live again, which is
 * what makes the reaping half of `takeIssueLeases` safe.
 */
export function issueLeaseHeldSql(projectId: SQL | string, issueKey: SQL | string): SQL {
  return sql`EXISTS (
    SELECT 1
      FROM issue_leases l
      JOIN agent_sessions ls ON ls.id = l.session_id
     WHERE l.project_id = ${projectId}
       AND l.issue_key = ${issueKey}
       AND ls.status NOT IN (${terminalSessionList})
  )`;
}

/**
 * Whether anything at all is working this issue right now.
 *
 * Three ways an issue is somebody's work, and every reader of this question
 * needs all three: a job that has not reached a terminal status, a pipeline run
 * opened over the issue itself, or a run session holding its lease. The
 * admissible read and the orphan sweep each wrote this out in full and had to
 * be kept in step by hand; they call this instead.
 */
export function issueWorkInFlightSql(args: {
  issueId: SQL | string;
  projectId: SQL | string;
  issueKey: SQL | string;
}): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM jobs wj
       WHERE wj.issue_id = ${args.issueId}
         AND wj.status NOT IN (${terminalJobList})
    )
    OR EXISTS (
      SELECT 1 FROM pipeline_runs wr
       WHERE wr.issue_id = ${args.issueId}
         AND wr.status IN (${livePipelineRunList})
    )
    OR ${issueLeaseHeldSql(args.projectId, args.issueKey)}
  )`;
}

/** One issue's holder, as the refusal and the lease endpoint report it. */
export interface IssueLeaseHolder {
  issueKey: string;
  deviceId: string;
  sessionId: string;
  runId: string;
  acquiredAt: string;
}

/**
 * A take refused because somebody live already holds one of the keys.
 *
 * Carries the holders rather than a count: an operator told only that something
 * is held has to open the database to learn which box to stop.
 */
export class IssueLeaseHeldError extends Error {
  readonly code = 'ISSUE_LEASE_HELD';
  readonly holders: IssueLeaseHolder[];

  constructor(holders: IssueLeaseHolder[], askingDeviceId: string) {
    super(refusalText(holders, askingDeviceId));
    this.name = 'IssueLeaseHeldError';
    this.holders = holders;
  }
}

/**
 * What a refused box is told, which differs by who is holding.
 *
 * A box refused by its own earlier run has a different act to take — close that
 * run session, or wait for the reaper — from one refused by a stranger, whose
 * only act is to work something else. One sentence for both states hides which
 * of the two it is.
 */
function refusalText(holders: IssueLeaseHolder[], askingDeviceId: string): string {
  const lines = holders.map((h) => {
    const whose =
      h.deviceId === askingDeviceId
        ? `this same box (device ${h.deviceId}), under run session ${h.sessionId}`
        : `another box (device ${h.deviceId}), under run session ${h.sessionId}`;
    return `  ${h.issueKey} is held by ${whose}, taken at ${h.acquiredAt}`;
  });
  const ownOnly = holders.every((h) => h.deviceId === askingDeviceId);
  const advice = ownOnly
    ? 'Close that run session before opening another over the same issues, or wait for it to be reaped.'
    : 'Open a run session over issues no live run session holds; the holder above is the box to ask.';
  return [
    `issue lease held: ${holders.length} of the issues asked for are already being worked.`,
    ...lines,
    advice,
  ].join('\n');
}

/** The holders of these keys, whoever they are, for a refusal or a read. */
async function holdersOf(
  executor: Tx,
  args: { projectId: string; issueKeys: string[] },
): Promise<IssueLeaseHolder[]> {
  if (args.issueKeys.length === 0) return [];
  const keyList = sql.join(
    args.issueKeys.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = (await executor.execute(sql`
    SELECT l.issue_key, l.device_id, l.session_id, l.run_id, l.acquired_at
      FROM issue_leases l
      JOIN agent_sessions ls ON ls.id = l.session_id
     WHERE l.project_id = ${args.projectId}
       AND l.issue_key IN (${keyList})
       AND ls.status NOT IN (${terminalSessionList})
     ORDER BY l.issue_key
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    issueKey: String(r.issue_key),
    deviceId: String(r.device_id),
    sessionId: String(r.session_id),
    runId: String(r.run_id),
    acquiredAt: new Date(String(r.acquired_at)).toISOString(),
  }));
}

/**
 * Take the lease on every key of one group, or take none of them.
 *
 * Called inside the transaction that inserts the run and the session, so a
 * refusal rolls those back with it: a partial open — some issues leased, the
 * rest silently joined — is the state this exists to prevent, not a smaller
 * version of it.
 *
 * The keys are sorted before anything touches them. Two boxes opening over the
 * same pair in opposite orders would otherwise each hold the row the other is
 * waiting for, and a deadlock is a box that never reports at all.
 */
export async function takeIssueLeases(
  executor: Tx,
  args: {
    projectId: string;
    deviceId: string;
    sessionId: string;
    runId: string;
    issueKeys: string[];
  },
): Promise<void> {
  const keys = [...new Set(args.issueKeys)].sort();
  if (keys.length === 0) return;
  const keyList = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );

  // Only rows whose session is already terminal, and terminal is monotone, so
  // this can never take a lease away from a run that is still working.
  await executor.execute(sql`
    DELETE FROM issue_leases l
     USING agent_sessions ls
     WHERE ls.id = l.session_id
       AND l.project_id = ${args.projectId}
       AND l.issue_key IN (${keyList})
       AND ls.status IN (${terminalSessionList})
  `);

  const taken = (await executor.execute(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    SELECT ${args.projectId}, k, ${args.deviceId}, ${args.sessionId}, ${args.runId}
      FROM (VALUES ${sql.join(
        keys.map((k) => sql`(${k})`),
        sql`, `,
      )}) AS v(k)
    ORDER BY k
    ON CONFLICT (project_id, issue_key) DO NOTHING
    RETURNING issue_key
  `)) as unknown as Array<{ issue_key: string }>;

  if (taken.length === keys.length) return;

  const won = new Set(taken.map((r) => String(r.issue_key)));
  const lost = keys.filter((k) => !won.has(k));
  const holders = await holdersOf(executor, { projectId: args.projectId, issueKeys: lost });
  throw new IssueLeaseHeldError(
    holders.length > 0
      ? holders
      : lost.map((issueKey) => ({
          issueKey,
          deviceId: 'unknown',
          sessionId: 'unknown',
          runId: 'unknown',
          acquiredAt: new Date(0).toISOString(),
        })),
    args.deviceId,
  );
}

/**
 * Every project one device may be told about.
 *
 * The bindings it serves, plus any project it itself holds a lease in. The
 * first is the authorization bound — a box is not told what is happening on a
 * project it does not serve. The second is what keeps a box able to read back
 * its own lease when its runner binding is withdrawn mid-run, which would
 * otherwise have it report a lease returned that it still holds.
 */
function reachableProjects(deviceId: string): SQL {
  return sql`(
    SELECT r.project_id FROM runners r WHERE r.device_id = ${deviceId}
    UNION
    SELECT l2.project_id FROM issue_leases l2 WHERE l2.device_id = ${deviceId}
  )`;
}

/** What one box is told about one issue's lease. */
export interface DeviceIssueLease {
  /** Held by a live run session on ANY box, across the projects this one serves. */
  held: boolean;
  /** Held by THIS box. What a close loop asking "have I given this back" means. */
  heldByThisDevice: boolean;
  holder: IssueLeaseHolder | null;
}

/**
 * One issue's lease as one box sees it.
 *
 * The two booleans are different questions and a caller has to say which it is
 * asking. `held` is the fleet-wide fact the pool turns on; `heldByThisDevice`
 * is what a box's own close loop needs, because a box that never sees its own
 * release land never marks the run closed.
 */
export async function readDeviceIssueLease(args: {
  deviceId: string;
  issueKey: string;
}): Promise<DeviceIssueLease> {
  const rows = (await db.execute(sql`
    SELECT l.project_id, l.issue_key, l.device_id, l.session_id, l.run_id, l.acquired_at
      FROM issue_leases l
      JOIN agent_sessions ls ON ls.id = l.session_id
     WHERE l.issue_key = ${args.issueKey}
       AND ls.status NOT IN (${terminalSessionList})
       AND l.project_id IN ${reachableProjects(args.deviceId)}
     ORDER BY (l.device_id = ${args.deviceId}) DESC, l.acquired_at ASC
     LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return { held: false, heldByThisDevice: false, holder: null };
  const holder: IssueLeaseHolder = {
    issueKey: String(row.issue_key),
    deviceId: String(row.device_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    acquiredAt: new Date(String(row.acquired_at)).toISOString(),
  };
  return { held: true, heldByThisDevice: holder.deviceId === args.deviceId, holder };
}

/**
 * Give one issue's lease back, from the box that holds it and no other.
 *
 * Scoped to the asking device on purpose: a box that can release another box's
 * lease can take an issue out from under a running agent, which is the same
 * defect this module exists to close, arriving from the other side.
 */
export async function releaseIssueLeaseRow(args: {
  deviceId: string;
  issueKey: string;
}): Promise<void> {
  await db.execute(sql`
    DELETE FROM issue_leases
     WHERE device_id = ${args.deviceId}
       AND issue_key = ${args.issueKey}
  `);
}
