// The one read of what core recorded on a workspace's projects (ISS-951 round 3): their masters'
// passes opened and settled, issues' status moves, merge marks, change requests, runs started and
// ended, and the dialogs a master's pane stopped on. The peek's Recent list reads a project's newest
// of them (`recent.ts`), and each row's timeline lane reads the last two hours of them (`laneOf`,
// MK-10 C): one statement for every project asked, and no second path for either.
//
// Each event names its issue by title as well as by key, read in the same statement from the
// project's issues by sequence (`issues_project_iss_seq_uq`), and with no record key left in it
// (`record-keys.ts:withoutRecordKeys`): a person reads the title, the key stays for a tooltip
// (ISS-951 round 4).
//
// Every source is reached through its own index from the project: a status move through each of its
// issues (`kernel_transitions (entity, entity_id)`), a run's end through each of its run sessions.
// Round 2 ordered the whole transitions table by time and filtered it to the project, which reads
// every job's and session's move of every project before it finds a project's few, and a peek opened
// on Forge showed "…" while it ran.

import {
  MASTER_SESSION_KIND,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import type {
  OrgActivityEvent,
  OrgActivityLane,
  OrgActivitySpan,
} from '@forge/contracts/org-activity';
import { withoutRecordKeys } from '@forge/contracts/record-keys';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
const ENDED = list(terminalAgentSessionStatuses);

/** An event as the read answers it: what Recent lists, and the span a lane pairs a start and end by. */
export interface ProjectEvent extends OrgActivityEvent {
  /** A run's session, or a dialog's start, shared by its start and its end. */
  span?: string;
}

interface EventRow {
  project_id: string;
  at: string | Date | null;
  kind: OrgActivityEvent['kind'];
  prefix: string | null;
  seq: number | null;
  key: string | null;
  verb: OrgActivityEvent['verb'] | null;
  dispatched: number | null;
  to_status: OrgActivityEvent['to'] | null;
  ref: string | null;
  span: string | null;
  issue_title: string | null;
}

/**
 * Each project's events at or after `since` (all of them where null), newest first: at most `limit`
 * of each source per project. A run or a dialog still open is read whenever it began, so a lane
 * draws what still runs from the edge of its reach.
 */
export async function readProjectEvents(
  projectIds: readonly string[],
  opts: { since: Date | null; limit: number },
): Promise<Map<string, ProjectEvent[]>> {
  const out = new Map<string, ProjectEvent[]>(projectIds.map((id) => [id, []]));
  if (projectIds.length === 0) return out;
  const since = opts.since
    ? sql`${opts.since.toISOString()}::timestamptz`
    : sql`'-infinity'::timestamptz`;
  const limit = opts.limit;
  const ids = sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = rowsOf<EventRow>(
    await db.execute(sql`
      SELECT p.id AS project_id, p.issue_prefix AS prefix, e.*, it.title AS issue_title
        FROM (SELECT id, issue_prefix FROM projects WHERE id IN (${ids})) p
        CROSS JOIN LATERAL (
          (SELECT q.started_at AS at, 'pass_opened'::text AS kind, NULL::int AS seq,
                  q.issue_key AS key, q.verb::text AS verb, NULL::int AS dispatched,
                  NULL::text AS to_status, NULL::text AS ref, NULL::text AS span
             FROM master_passes q WHERE q.project_id = p.id AND q.started_at >= ${since}
            ORDER BY q.started_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT q.ended_at, 'pass_settled', NULL, q.issue_key, q.verb, cardinality(q.dispatched),
                  NULL, NULL, NULL
             FROM master_passes q WHERE q.project_id = p.id AND q.ended_at >= ${since}
            ORDER BY q.ended_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT m.at, 'status', i.iss_seq, NULL, NULL, NULL, m.to_status, NULL, NULL
             FROM issues i
             CROSS JOIN LATERAL (
               SELECT t.created_at AS at, t.to_status FROM kernel_transitions t
                WHERE t.entity = 'issue' AND t.entity_id = i.id AND t.created_at >= ${since}
                ORDER BY t.created_at DESC LIMIT ${limit}) m
            WHERE i.project_id = p.id
            ORDER BY m.at DESC LIMIT ${limit})
          UNION ALL
          (SELECT i.merged_at, 'merged', i.iss_seq, NULL, NULL, NULL, NULL, NULL, NULL
             FROM issues i WHERE i.project_id = p.id AND i.merged_at >= ${since}
            ORDER BY i.merged_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT pr.created_at, 'change_request',
                  (SELECT i.iss_seq FROM repo_pull_request_issues l JOIN issues i ON i.id = l.issue_id
                    WHERE l.pull_request_id = pr.id ORDER BY l.position LIMIT 1),
                  NULL, NULL, NULL, NULL,
                  CASE WHEN pr.host = 'gitlab' THEN '!' ELSE '#' END || pr.number, NULL
             FROM repo_pull_requests pr WHERE pr.project_id = p.id AND pr.created_at >= ${since}
            ORDER BY pr.created_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT COALESCE(s.started_at, s.created_at), 'run_started', NULL,
                  s.metadata -> ${RUN_ISSUES_METADATA_KEY} ->> 0, NULL, NULL, NULL, NULL, s.id::text
             FROM agent_sessions s
            WHERE s.project_id = p.id AND s.kind = ${RUN_SESSION_KIND}
              AND (COALESCE(s.started_at, s.created_at) >= ${since} OR s.status NOT IN (${ENDED}))
            ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT ${limit})
          UNION ALL
          (SELECT e.at, 'run_ended', NULL, s.metadata -> ${RUN_ISSUES_METADATA_KEY} ->> 0,
                  NULL, NULL, NULL, NULL, s.id::text
             FROM agent_sessions s
             CROSS JOIN LATERAL (
               SELECT t.created_at AS at FROM kernel_transitions t
                WHERE t.entity = 'session' AND t.entity_id = s.id AND t.to_status IN (${ENDED})
                  AND t.created_at >= ${since}
                ORDER BY t.created_at DESC LIMIT 1) e
            WHERE s.project_id = p.id AND s.kind = ${RUN_SESSION_KIND}
            ORDER BY e.at DESC LIMIT ${limit})
          UNION ALL
          (SELECT (d ->> 'from')::timestamptz, 'dialog_started', NULL, NULL, NULL, NULL, NULL, NULL,
                  s.id::text || '|' || (d ->> 'from')
             FROM agent_sessions s
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.metadata -> 'paneDialogs') = 'array'
                    THEN s.metadata -> 'paneDialogs' ELSE '[]'::jsonb END) d
            WHERE s.project_id = p.id AND s.kind = ${MASTER_SESSION_KIND}
              AND ((d ->> 'from')::timestamptz >= ${since} OR d ->> 'to' IS NULL)
            ORDER BY 1 DESC LIMIT ${limit})
          UNION ALL
          (SELECT (d ->> 'to')::timestamptz, 'dialog_ended', NULL, NULL, NULL, NULL, NULL, NULL,
                  s.id::text || '|' || (d ->> 'from')
             FROM agent_sessions s
             CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(s.metadata -> 'paneDialogs') = 'array'
                    THEN s.metadata -> 'paneDialogs' ELSE '[]'::jsonb END) d
            WHERE s.project_id = p.id AND s.kind = ${MASTER_SESSION_KIND}
              AND d ->> 'to' IS NOT NULL AND (d ->> 'to')::timestamptz >= ${since}
            ORDER BY 1 DESC LIMIT ${limit})
        ) e
        LEFT JOIN LATERAL (
          SELECT i.title FROM issues i
           WHERE i.project_id = p.id
             AND i.iss_seq = COALESCE(
                   e.seq,
                   CASE WHEN e.key ~ ('^(ISS|' || COALESCE(p.issue_prefix, 'ISS') || ')-[0-9]{1,9}$')
                        THEN substring(e.key FROM '([0-9]+)$')::int END)
        ) it ON true
       WHERE e.at IS NOT NULL
       ORDER BY e.at DESC`),
  );
  for (const r of rows) {
    const issueKey =
      r.seq !== null && r.seq !== undefined ? formatIssueRef(r.prefix, Number(r.seq)) : r.key;
    out.get(String(r.project_id))?.push({
      at: new Date(r.at as string).toISOString(),
      kind: r.kind,
      issueKey: issueKey ?? null,
      issueTitle: r.issue_title
        ? withoutRecordKeys(r.issue_title, r.prefix ? [r.prefix] : [])
        : null,
      ...(r.verb ? { verb: r.verb } : {}),
      ...(r.dispatched !== null && r.dispatched !== undefined
        ? { dispatched: Number(r.dispatched) }
        : {}),
      ...(r.to_status ? { to: r.to_status } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
      ...(r.span ? { span: r.span } : {}),
    });
  }
  return out;
}

/**
 * A project's lane from `from` to `to`, out of its events newest first: a tick for each pass opened,
 * a dot for each status move, and a bar for each run and each dialog, from its start (or the lane's
 * edge where it began before) to its end (or null while it still runs). A dialog the master stands on
 * that no span recorded (a box that sent it before spans were kept) is drawn from when it was seen.
 */
export function laneOf(
  events: readonly ProjectEvent[],
  from: Date,
  to: Date,
  standing: { dialogSince: string | null } = { dialogSince: null },
): OrgActivityLane {
  const edge = from.toISOString();
  const within = (at: string) => Date.parse(at) >= from.getTime() && Date.parse(at) <= to.getTime();
  const spans = (start: OrgActivityEvent['kind'], end: OrgActivityEvent['kind']) => {
    const open = new Map<string, OrgActivitySpan>();
    for (const e of [...events].reverse()) {
      if (!e.span) continue;
      if (e.kind === start) open.set(e.span, { from: e.at < edge ? edge : e.at, to: null });
      if (e.kind === end) {
        const held = open.get(e.span) ?? { from: edge, to: null };
        open.set(e.span, { ...held, to: e.at });
      }
    }
    return [...open.values()].filter((s) => s.to === null || Date.parse(s.to) >= from.getTime());
  };
  const dialogs = spans('dialog_started', 'dialog_ended');
  if (standing.dialogSince && !dialogs.some((d) => d.to === null)) {
    dialogs.push({ from: standing.dialogSince < edge ? edge : standing.dialogSince, to: null });
  }
  const at = (kind: OrgActivityEvent['kind']) =>
    events
      .filter((e) => e.kind === kind && within(e.at))
      .map((e) => e.at)
      .reverse();
  return {
    from: edge,
    passes: at('pass_opened'),
    runs: spans('run_started', 'run_ended'),
    moves: at('status'),
    dialogs,
  };
}
