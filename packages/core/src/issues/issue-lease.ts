/**
 * Who is working one issue — asked once, answered once, fleet-wide (ISS-1109).
 *
 * This module is the only writer of `issue_leases` and the only place the SQL
 * for "is this issue being worked" is written: asked four ways, one of them
 * filtering on the asker, box B was told an issue box A was running was free.
 *
 * A lease is taken by a conditional write the primary key can refuse, never by
 * a read followed by a write: `takeIssueLeases` clears rows whose session is
 * already terminal and then inserts with `ON CONFLICT DO NOTHING`, so the loser
 * of a race is told no by Postgres rather than by a check that raced.
 *
 * `(project_id, issue_key)` is the identity on every path, take and give-back
 * alike, and `resolveLeaseKey` is where a caller's key becomes that pair.
 * naming -> packages/core/src/issues/session-claim.ts — which RUN may write a record.
 */

import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type { IssueTakeRefusalCode } from '@forge/contracts/issues';
import { TERMINAL_JOB_STATUSES, UNHELD_LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';

export const terminalSessionList = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

const terminalJobList = sql.join(
  TERMINAL_JOB_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const unheldLiveJobList = sql.join(
  UNHELD_LIVE_JOB_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const livePipelineRunList = sql.join(
  LIVE_PIPELINE_RUN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** Held-ness is the row AND a non-terminal session. `docs/modules/issues/issue-lease.md`. */
function issueLeaseHeldSql(
  projectId: SQL | string,
  issueKey: SQL | string,
  exceptRunId: string | null = null,
): SQL {
  const notThatRun =
    exceptRunId === null ? sql`` : sql` AND l.run_id IS DISTINCT FROM ${exceptRunId}`;
  return sql`EXISTS (
    SELECT 1
      FROM issue_leases l
      JOIN agent_sessions ls ON ls.id = l.session_id
     WHERE l.project_id = ${projectId}
       AND l.issue_key = ${issueKey}
       AND ls.status NOT IN (${terminalSessionList})${notThatRun}
  )`;
}

/** A non-terminal job, a pipeline run over it, or a held lease — all three. */
export function issueWorkInFlightSql(args: {
  issueId: SQL | string;
  projectId: SQL | string;
  issueKey: SQL | string;
  /** A run whose own job, run row and fleet lease are not counted: the one handing the issue back. */
  exceptRunId?: string | null;
}): SQL {
  const run = args.exceptRunId ?? null;
  const jobOfOther = run === null ? sql`` : sql` AND wj.pipeline_run_id IS DISTINCT FROM ${run}`;
  const otherRun = run === null ? sql`` : sql` AND wr.id <> ${run}`;
  return sql`(
    EXISTS (
      SELECT 1 FROM jobs wj
       WHERE wj.issue_id = ${args.issueId}
         AND wj.status NOT IN (${terminalJobList})${jobOfOther}
    )
    OR EXISTS (
      SELECT 1 FROM pipeline_runs wr
       WHERE wr.issue_id = ${args.issueId}
         AND wr.status IN (${livePipelineRunList})${otherRun}
    )
    OR ${issueLeaseHeldSql(args.projectId, args.issueKey, run)}
  )`;
}

/**
 * Whether a box is moving the issue now (ISS-1213), narrower than {@link issueWorkInFlightSql}: a
 * `held` job waits on a person and a `paused` run on a resume, so neither puts a box on it.
 */
export function issueWorkMovingSql(args: {
  issueId: SQL | string;
  projectId: SQL | string;
  issueKey: SQL | string;
}): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM jobs mj
       WHERE mj.issue_id = ${args.issueId}
         AND mj.status IN (${unheldLiveJobList})
    )
    OR EXISTS (
      SELECT 1 FROM pipeline_runs mr
       WHERE mr.issue_id = ${args.issueId}
         AND mr.status = 'running'
    )
    OR ${issueLeaseHeldSql(args.projectId, args.issueKey)}
  )`;
}

/**
 * Whether a run session that has not ended was declared over the issue: the run ledger's own
 * record that a box has it in hand, which a rescue reads as no wake lost (eco round 4, #46).
 */
export function issueRunDeclaredSql(args: {
  projectId: SQL | string;
  issueKey: SQL | string;
}): SQL {
  return sql`EXISTS (
    SELECT 1
      FROM pipeline_runs dr
      JOIN agent_sessions ds ON ds.pipeline_run_id = dr.id
     WHERE dr.project_id = ${args.projectId}
       AND ds.kind = ${RUN_SESSION_KIND}
       AND ds.status NOT IN (${terminalSessionList})
       AND dr.metadata -> ${RUN_ISSUES_METADATA_KEY} ? (${args.issueKey})
  )`;
}

/** Whether a run session holds the issue now: the fleet lease of a run that has not ended. */
export function issueRunLiveSql(args: { projectId: SQL | string; issueKey: SQL | string }): SQL {
  return issueLeaseHeldSql(args.projectId, args.issueKey);
}

/** One issue's holder, as the refusal and the lease endpoint report it. */
export interface IssueLeaseHolder {
  issueKey: string;
  deviceId: string;
  sessionId: string;
  runId: string;
  acquiredAt: string;
}

const refuse = refuser<IssueTakeRefusalCode>('ISSUE_TAKE_REFUSED');

/** What a refused box is told, which differs by who holds. */
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
 * Take every key of one group, or none, inside the caller's transaction.
 * Per-key and in sorted order; why that is not the same as a sorted whole-group
 * DELETE+INSERT: `docs/modules/issues/issue-lease.md`.
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

  // One key at a time, in key order, or two openers can invert and Postgres answers with a deadlock
  // abort instead of the refusal. A lease of an ended session is cleared before the take.
  const take = async (key: string): Promise<boolean> => {
    await executor.execute(sql`
      DELETE FROM issue_leases l
       USING agent_sessions ls
       WHERE ls.id = l.session_id
         AND l.project_id = ${args.projectId}
         AND l.issue_key = ${key}
         AND ls.status IN (${terminalSessionList})
    `);
    const taken = (await executor.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${args.projectId}, ${key}, ${args.deviceId}, ${args.sessionId}, ${args.runId})
      ON CONFLICT (project_id, issue_key) DO NOTHING
      RETURNING issue_key
    `)) as unknown as Array<{ issue_key: string }>;
    return taken.length > 0;
  };

  let lost: string[] = [];
  for (const key of keys) if (!(await take(key))) lost.push(key);
  if (lost.length === 0) return;

  // A holder whose session ended between the insert and this read is gone: take that key again
  // rather than refuse naming a holder that does not exist.
  let holders = await holdersOf(executor, { projectId: args.projectId, issueKeys: lost });
  const vacated = lost.filter((k) => !holders.some((h) => h.issueKey === k));
  if (vacated.length > 0) {
    const retaken = new Set<string>();
    for (const key of vacated) if (await take(key)) retaken.add(key);
    lost = lost.filter((k) => !retaken.has(k));
    if (lost.length === 0) return;
    holders = await holdersOf(executor, { projectId: args.projectId, issueKeys: lost });
  }
  throw refuse('ISSUE_LEASE_HELD', refusalText(holders, args.deviceId));
}

/** What a give-back did, or why it did nothing. */
export type IssueLeaseRelease =
  | { released: true; projectId: string }
  | { released: false; reason: 'not_held'; projectIds: [] }
  | { released: false; reason: 'ambiguous'; projectIds: string[] };

/**
 * Give one issue's lease back, for the project it was taken for and no other.
 * The identity is settled before anything is removed, so `not_held` and
 * `ambiguous` are answers rather than deletes; `device_id` narrows and never
 * identifies. Why, and the executor: `docs/modules/issues/issue-lease.md`.
 */
export async function releaseIssueLeaseRow(
  executor: Tx,
  args: {
    deviceId: string;
    issueKey: string;
    projectId?: string | null;
  },
): Promise<IssueLeaseRelease> {
  const inProject = args.projectId ? sql`AND project_id = ${args.projectId}` : sql.empty();
  const candidates = (await executor.execute(sql`
    SELECT project_id
      FROM issue_leases
     WHERE device_id = ${args.deviceId}
       AND issue_key = ${args.issueKey}
       ${inProject}
     ORDER BY project_id
       FOR UPDATE
  `)) as unknown as Array<Record<string, unknown>>;
  const projectIds = candidates.map((r) => String(r.project_id));

  if (projectIds.length === 0) return { released: false, reason: 'not_held', projectIds: [] };
  if (projectIds.length > 1) return { released: false, reason: 'ambiguous', projectIds };

  const projectId = projectIds[0] as string;
  await executor.execute(sql`
    DELETE FROM issue_leases
     WHERE project_id = ${projectId}
       AND issue_key = ${args.issueKey}
       AND device_id = ${args.deviceId}
  `);
  return { released: true, projectId };
}
