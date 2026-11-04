// The peek's Recent list (ISS-951, MK-9): the newest things core already recorded on one project —
// its master's passes opened and settled, issues' status moves, merge marks, change requests opened
// and merged, and runs started and ended. Read only when a person opens the list, never by the
// workspace's rows.

import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import {
  ORG_ACTIVITY_RECENT_LIMIT,
  type OrgActivityEvent,
  type OrgActivityRecent,
} from '@forge/contracts/org-activity';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const ENDED = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

interface EventRow {
  at: string | Date;
  kind: OrgActivityEvent['kind'];
  prefix: string | null;
  seq: number | null;
  /** A pass's issue key as the master wrote it; a run's first issue as its box declared it. */
  key: string | null;
  verb: OrgActivityEvent['verb'] | null;
  dispatched: number | null;
  to_status: OrgActivityEvent['to'] | null;
  ref: string | null;
}

/** The name of a live project of the org, or null where the org holds no such project. */
export async function projectOfOrg(orgId: string, projectId: string): Promise<string | null> {
  const [row] = rowsOf<{ name: string }>(
    await db.execute(
      sql`SELECT name FROM projects WHERE id = ${projectId} AND org_id = ${orgId} AND archived_at IS NULL`,
    ),
  );
  return row?.name ?? null;
}

/** The project's newest events, newest first; `limit` per source, then `limit` in all. */
export async function readProjectRecent(
  projectId: string,
  limit: number = ORG_ACTIVITY_RECENT_LIMIT,
): Promise<OrgActivityRecent> {
  const rows = rowsOf<EventRow>(
    await db.execute(sql`
      WITH proj AS (SELECT id, issue_prefix FROM projects WHERE id = ${projectId}),
      passes AS (
        (SELECT started_at AS at, 'pass_opened' AS kind, issue_key AS key, verb, NULL::int AS dispatched
           FROM master_passes WHERE project_id = ${projectId} ORDER BY started_at DESC LIMIT ${limit})
        UNION ALL
        (SELECT ended_at, 'pass_settled', issue_key, verb, cardinality(dispatched)
           FROM master_passes WHERE project_id = ${projectId} AND ended_at IS NOT NULL
          ORDER BY ended_at DESC LIMIT ${limit})
      ),
      moves AS (
        SELECT t.created_at AS at, i.iss_seq AS seq, t.to_status
          FROM kernel_transitions t JOIN issues i ON i.id = t.entity_id
         WHERE t.entity = 'issue' AND i.project_id = ${projectId}
         ORDER BY t.created_at DESC LIMIT ${limit}
      ),
      merges AS (
        SELECT merged_at AS at, iss_seq AS seq FROM issues
         WHERE project_id = ${projectId} AND merged_at IS NOT NULL
         ORDER BY merged_at DESC LIMIT ${limit}
      ),
      requests AS (
        SELECT pr.created_at AS at, pr.host, pr.number,
               (SELECT i.iss_seq FROM repo_pull_request_issues l JOIN issues i ON i.id = l.issue_id
                 WHERE l.pull_request_id = pr.id ORDER BY l.position LIMIT 1) AS seq
          FROM repo_pull_requests pr WHERE pr.project_id = ${projectId}
         ORDER BY pr.created_at DESC LIMIT ${limit}
      ),
      runs AS (
        (SELECT COALESCE(s.started_at, s.created_at) AS at, 'run_started' AS kind,
                s.metadata -> ${RUN_ISSUES_METADATA_KEY} ->> 0 AS key
           FROM agent_sessions s WHERE s.project_id = ${projectId} AND s.kind = ${RUN_SESSION_KIND}
          ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT ${limit})
        UNION ALL
        (SELECT t.created_at, 'run_ended', s.metadata -> ${RUN_ISSUES_METADATA_KEY} ->> 0
           FROM kernel_transitions t JOIN agent_sessions s ON s.id = t.entity_id
          WHERE t.entity = 'session' AND s.project_id = ${projectId} AND s.kind = ${RUN_SESSION_KIND}
            AND t.to_status IN (${ENDED})
          ORDER BY t.created_at DESC LIMIT ${limit})
      )
      SELECT * FROM (
        SELECT at, kind, NULL AS prefix, NULL::int AS seq, key, verb, dispatched,
               NULL AS to_status, NULL AS ref FROM passes
        UNION ALL
        SELECT at, 'status', (SELECT issue_prefix FROM proj), seq, NULL, NULL, NULL, to_status, NULL FROM moves
        UNION ALL
        SELECT at, 'merged', (SELECT issue_prefix FROM proj), seq, NULL, NULL, NULL, NULL, NULL FROM merges
        UNION ALL
        SELECT at, 'change_request', (SELECT issue_prefix FROM proj), seq, NULL, NULL, NULL, NULL,
               CASE WHEN host = 'gitlab' THEN '!' ELSE '#' END || number FROM requests
        UNION ALL
        SELECT at, kind, NULL, NULL, key, NULL, NULL, NULL, NULL FROM runs
      ) e
      WHERE at IS NOT NULL
      ORDER BY at DESC
      LIMIT ${limit}`),
  );
  return {
    projectId,
    items: rows.map((r): OrgActivityEvent => {
      const issueKey =
        r.seq !== null && r.seq !== undefined ? formatIssueRef(r.prefix, Number(r.seq)) : r.key;
      return {
        at: new Date(r.at).toISOString(),
        kind: r.kind,
        issueKey: issueKey ?? null,
        ...(r.verb ? { verb: r.verb } : {}),
        ...(r.dispatched !== null && r.dispatched !== undefined
          ? { dispatched: Number(r.dispatched) }
          : {}),
        ...(r.to_status ? { to: r.to_status } : {}),
        ...(r.ref ? { ref: r.ref } : {}),
      };
    }),
  };
}
