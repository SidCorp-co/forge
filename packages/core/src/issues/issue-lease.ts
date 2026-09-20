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
 *
 * `(project_id, issue_key)` is the identity on every path, take and give-back
 * alike, and `resolveLeaseKey` is where a caller's key becomes that pair.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { TERMINAL_JOB_STATUSES } from '../jobs/status-sets.js';
import {
  canonicalIssueKey,
  issueRefPrefixOf,
  LEGACY_ISSUE_PREFIX,
  parseIssueRef,
} from '../lib/issue-ref.js';
import { issuePrefixHolder } from './issue-prefix-read.js';

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

/** Held-ness is the row AND a non-terminal session. `docs/modules/issues/issue-lease.md`. */
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

/** A non-terminal job, a pipeline run over it, or a held lease — all three. */
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

/** Refused: somebody live holds a key. Carries holders, not a count. */
export class IssueLeaseHeldError extends Error {
  readonly code = 'ISSUE_LEASE_HELD';
  readonly holders: IssueLeaseHolder[];

  constructor(holders: IssueLeaseHolder[], askingDeviceId: string) {
    super(refusalText(holders, askingDeviceId));
    this.name = 'IssueLeaseHeldError';
    this.holders = holders;
  }
}

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

  const lost: string[] = [];
  for (const key of keys) {
    // One key at a time, in key order, or two openers can invert and Postgres
    // answers with a deadlock abort instead of the refusal.
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

    if (taken.length === 0) lost.push(key);
  }

  if (lost.length === 0) return;

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

/** The bindings it serves, plus any project it holds a lease in. */
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

/** One issue's lease as one box sees it. */
export async function readDeviceIssueLease(args: {
  deviceId: string;
  issueKey: string;
  projectId?: string | null;
}): Promise<DeviceIssueLease> {
  // Unnarrowed, the answer is tie-broken across every project this box reaches,
  // which can be a lease the caller did not mean (ISS-1139).
  const inProject = args.projectId ? sql`AND l.project_id = ${args.projectId}` : sql.empty();
  const rows = (await db.execute(sql`
    SELECT l.project_id, l.issue_key, l.device_id, l.session_id, l.run_id, l.acquired_at
      FROM issue_leases l
      JOIN agent_sessions ls ON ls.id = l.session_id
     WHERE l.issue_key = ${args.issueKey}
       AND ls.status NOT IN (${terminalSessionList})
       AND l.project_id IN ${reachableProjects(args.deviceId)}
       ${inProject}
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

/** A key that reaches no lease, with the status that says which way. */
export interface LeaseKeyRefusal {
  code:
    | 'ISSUE_LEASE_KEY_SHAPE'
    | 'ISSUE_LEASE_KEY_UNKNOWN_PREFIX'
    | 'ISSUE_LEASE_KEY_PROJECT_MISMATCH';
  status: 400 | 404;
  message: string;
}

/** One caller's key as the store holds it, and the project it named. */
export interface ResolvedLeaseKey {
  /** The canonical `ISS-<seq>`, whichever vocabulary the caller used. */
  issueKey: string;
  /** The project the prefix or the caller named, null where neither did. */
  projectId: string | null;
}

/**
 * Whatever key a caller sent, as the pair the table is keyed by. A prefixed key
 * is the interface's own second vocabulary and is mapped, not refused; a key
 * that reaches nothing is refused. `docs/modules/issues/issue-lease.md`.
 */
export async function resolveLeaseKey(args: {
  rawKey: string;
  projectId?: string | null;
}): Promise<{ ok: true; key: ResolvedLeaseKey } | { ok: false; refusal: LeaseKeyRefusal }> {
  const given = issueRefPrefixOf(args.rawKey);
  const parsed = parseIssueRef(args.rawKey, given ? [given] : []);
  if (!parsed.ok) {
    return {
      ok: false,
      refusal: { code: 'ISSUE_LEASE_KEY_SHAPE', status: 400, message: parsed.message },
    };
  }
  const issueKey = canonicalIssueKey(parsed.issSeq);
  let projectId = args.projectId ?? null;

  if (given && given !== LEGACY_ISSUE_PREFIX) {
    const named = (await issuePrefixHolder(given))?.projectId ?? null;
    if (named === null) {
      return {
        ok: false,
        refusal: {
          code: 'ISSUE_LEASE_KEY_UNKNOWN_PREFIX',
          status: 404,
          message: `\`${args.rawKey}\` names the issue prefix \`${given}\`, which no project answers to, so it reaches no lease. A prefix names the project an issue belongs to; send the prefix of a project this box serves, or the canonical \`${issueKey}\` the lease store keeps.`,
        },
      };
    }
    if (projectId !== null && projectId !== named) {
      return {
        ok: false,
        refusal: {
          code: 'ISSUE_LEASE_KEY_PROJECT_MISMATCH',
          status: 400,
          message: `\`${args.rawKey}\` names project ${named} through the prefix \`${given}\`, and \`projectId\` names ${projectId}. One request names one lease, so send the canonical \`${issueKey}\` with the project you mean, or the prefixed key on its own.`,
        },
      };
    }
    projectId = named;
  }

  return { ok: true, key: { issueKey, projectId } };
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
