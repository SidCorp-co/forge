// Reading a device's issue lease and resolving the key a lease call names.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { IssueTakeRefusalCode } from '@forge/contracts/issues';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  canonicalIssueKey,
  issueRefPrefixOf,
  LEGACY_ISSUE_PREFIX,
  parseIssueRef,
} from '../lib/issue-ref.js';
import { type IssueLeaseHolder, terminalSessionList } from './issue-lease.js';
import { issuePrefixHolder } from './issue-prefix-read.js';

/** The bindings it serves, plus any project it holds a lease in. */
function reachableProjects(deviceId: string): SQL {
  return sql`(
    SELECT r.project_id FROM runners r WHERE r.device_id = ${deviceId}
    UNION
    SELECT l2.project_id FROM issue_leases l2 WHERE l2.device_id = ${deviceId}
  )`;
}

/** What one box is told about one issue's lease. */
interface DeviceIssueLease {
  /** Held by a live run session on ANY box, across the projects this one serves. */
  held: boolean;
  /** Held by THIS box. What a close loop asking "have I given this back" means. */
  heldByThisDevice: boolean;
  holder: IssueLeaseHolder | null;
  /**
   * The issue has reached a terminal status. `null` is *not known to be over* —
   * no issue was reached — which a box keeps its run on (ISS-1245).
   */
  issueOver: boolean | null;
}

/**
 * Whether that pair's issue is over, read off the ISSUE and not the lease row:
 * the rows that most need the fact are the ones whose lease core already freed.
 * `iss_seq` restarts per project, so a request naming none is answered `null`
 * rather than tie-broken — a guess there closes the wrong project's run.
 */
async function readIssueOver(args: {
  deviceId: string;
  issueKey: string;
  projectId?: string | null;
}): Promise<boolean | null> {
  if (!args.projectId) return null;
  const parsed = parseIssueRef(args.issueKey);
  if (!parsed.ok) return null;
  const terminal = sql.join(
    ISSUE_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT (i.status IN (${terminal})) AS over
      FROM issues i
     WHERE i.project_id = ${args.projectId}
       AND i.iss_seq = ${parsed.issSeq}
       AND i.project_id IN ${reachableProjects(args.deviceId)}
     LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return row.over === true;
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
  const issueOver = await readIssueOver(args);
  const row = rows[0];
  if (!row) return { held: false, heldByThisDevice: false, holder: null, issueOver };
  const holder: IssueLeaseHolder = {
    issueKey: String(row.issue_key),
    deviceId: String(row.device_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    acquiredAt: new Date(String(row.acquired_at)).toISOString(),
  };
  return { held: true, heldByThisDevice: holder.deviceId === args.deviceId, holder, issueOver };
}

/** A key that reaches no lease, with the status that says which way. */
interface LeaseKeyRefusal {
  code: Extract<IssueTakeRefusalCode, `ISSUE_LEASE_KEY_${string}`>;
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
 * is mapped, not refused; only a key that reaches nothing at all is refused,
 * and an out-of-reach project is answered. `docs/modules/issues/issue-lease.md`.
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
      refusal: { code: 'ISSUE_LEASE_KEY_SHAPE', message: parsed.message },
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
          message: `\`${args.rawKey}\` names the issue prefix \`${given}\`, which no project answers to, so it reaches no lease. A prefix names the project an issue belongs to; send the prefix of a project this box serves, or the canonical \`${issueKey}\` the lease store keeps.`,
        },
      };
    }
    if (projectId !== null && projectId !== named) {
      return {
        ok: false,
        refusal: {
          code: 'ISSUE_LEASE_KEY_PROJECT_MISMATCH',
          message: `\`${args.rawKey}\` names project ${named} through the prefix \`${given}\`, and \`projectId\` names ${projectId}. One request names one lease, so send the canonical \`${issueKey}\` with the project you mean, or the prefixed key on its own.`,
        },
      };
    }
    projectId = named;
  }

  return { ok: true, key: { issueKey, projectId } };
}
