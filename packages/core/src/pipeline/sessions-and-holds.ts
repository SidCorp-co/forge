/**
 * One project's live agent sessions and what is held on it (ISS-1228): the pipeline surface's
 * whole read. No new state — sessions are `agent_sessions`, a session's issues are its
 * `issue_leases`, its job's `metadata.issueId` or its run's ledger entry (`held-issues.ts`, which the
 * sessions list reads too), what it waits on is the box's own `device_run_ledger` entry, a claim is
 * `issues.session_context.lease` read by `readClaim`, and a person's hold is the park record.
 */

import type { IssuePark } from '@forge/contracts';
import { sql } from 'drizzle-orm';
import {
  type LedgerRow,
  loadLedgerRows,
  newestReports,
  type SessionReport,
} from '../agent-sessions/box-report.js';
import { type HeldIssueRow, heldIssueRowsSql } from '../agent-sessions/held-issues.js';
import { db } from '../db/client.js';
import { type IssueStatus, terminalAgentSessionStatuses } from '../db/schema.js';
import { silenceLimitFrom } from '../devices/session-silence.js';
import { loadSilenceDeadlines } from '../devices/session-silence-read.js';
import { issueArchiveSide } from '../issues/archive.js';
import { loadIssuePark } from '../issues/park-view.js';
import { HUMAN_PARK_STATUSES, ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { holderFanout, readClaim } from './lease-fanout.js';
import { liveSessionWhere } from './live-session.js';
import { type LeaseReading, leaseIsWorkInProgress } from './session-claim.js';

export type { LedgerRow, SessionReport };

export interface HeldIssueRef {
  issueId: string;
  displayId: string;
  title: string;
}

/** An issue a live session holds, and whether its run reports it returned while core still holds it. */
export interface SessionIssueRef extends HeldIssueRef {
  boxReturned: boolean;
}

export interface LiveSession {
  id: string;
  kind: string;
  title: string | null;
  /** The job type and skill a step session was opened under, which its title begins with. */
  jobType: string | null;
  skillName: string | null;
  status: string;
  runtimeState: string | null;
  deviceId: string | null;
  deviceName: string | null;
  parentSessionId: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  issues: SessionIssueRef[];
  report: SessionReport | null;
  /** How long core lets this session go unheard before it ends it; `null` where no silence does. */
  silenceLimitMs: number | null;
}

export type Holder =
  | {
      by: 'session';
      sessionId: string;
      sessionTitle: string | null;
      sessionKind: string;
      deviceName: string | null;
      since: string;
      boxReturned: boolean;
    }
  | {
      by: 'claim';
      holder: string;
      /** The claim's last renewal: the blob records no time the claim began. */
      renewedAt: string | null;
      expiresAt: string | null;
      next: string | null;
    }
  | {
      by: 'person';
      /** One of `HUMAN_PARK_STATUSES`. */
      status: IssueStatus;
      owes: 'information' | 'decision' | 'resource' | null;
      since: string | null;
      why: string | null;
    };

export interface HeldIssue extends HeldIssueRef {
  status: string;
  holders: Holder[];
}

/** A chat whose turn is running on a box: listed nowhere on the Pipeline page, counted by its box. */
export interface RunningChat {
  id: string;
  deviceId: string | null;
}

export interface SessionsAndHolds {
  sessions: LiveSession[];
  holds: HeldIssue[];
  runningChats: RunningChat[];
  readAt: string;
}

export interface SessionRow {
  id: string;
  kind: string;
  title: string | null;
  job_type?: string | null;
  skill_name?: string | null;
  status: string;
  runtime_state: string | null;
  device_id: string | null;
  device_name: string | null;
  parent_session_id: string | null;
  started_at: Date | string | null;
  last_heartbeat_at: Date | string | null;
  created_at: Date | string;
  /** From `loadSilenceDeadlines`, epoch ms; absent reads as no limit. */
  silence_deadline?: number | null;
}

/** One issue a session holds, as `heldIssueRowsSql` reads it; the prefix is the project's own. */
export type LeaseRow = Omit<HeldIssueRow, 'issue_prefix'> & { issue_prefix?: string | null };

export interface IssueRow {
  id: string;
  iss_seq: number;
  title: string;
  status: string;
}

export interface ClaimInput {
  issue: IssueRow;
  lease: unknown;
  reading: LeaseReading;
}

export interface PersonInput {
  issue: IssueRow;
  holder: Extract<Holder, { by: 'person' }>;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

function leaseText(lease: unknown, key: string): string | null {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return null;
  const value = (lease as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The person's hold read off the park view: the record's own `why` first, then the move's reason. */
export function personHolderFromPark(
  status: IssueStatus,
  park: IssuePark | null,
): Extract<Holder, { by: 'person' }> {
  return {
    by: 'person',
    status,
    owes: park?.owes ?? null,
    since: park?.since ?? null,
    why: park?.record?.why ?? park?.reason ?? null,
  };
}

/** Pure: shape the rows the three reads returned. Order is the caller's rows' order. */
export function projectSessionsAndHolds(input: {
  prefix: string | null;
  sessions: readonly SessionRow[];
  ledger: readonly LedgerRow[];
  leases: readonly LeaseRow[];
  claims: readonly ClaimInput[];
  persons: readonly PersonInput[];
  runningChats: readonly { id: string; device_id: string | null }[];
  now: Date;
}): SessionsAndHolds {
  const ref = (row: { issue_id?: string; id?: string; iss_seq: number; title: string }) => ({
    issueId: (row.issue_id ?? row.id) as string,
    displayId: formatIssueRef(input.prefix, row.iss_seq),
    title: row.title,
  });

  const reportOf = newestReports(input.ledger);

  const issuesOf = new Map<string, SessionIssueRef[]>();
  const held = new Map<string, HeldIssue>();
  const holdOn = (issue: HeldIssueRef & { status: string }): HeldIssue => {
    const existing = held.get(issue.issueId);
    if (existing) return existing;
    const created: HeldIssue = { ...issue, holders: [] };
    held.set(issue.issueId, created);
    return created;
  };

  for (const l of input.leases) {
    // An issue its run returned and core let go is no longer the session's: not named, not held.
    if (!l.held) continue;
    const issue = ref(l);
    const boxReturned = l.box_returned;
    issuesOf.set(l.session_id, [...(issuesOf.get(l.session_id) ?? []), { ...issue, boxReturned }]);
    holdOn({ ...issue, status: l.status }).holders.push({
      by: 'session',
      sessionId: l.session_id,
      sessionTitle: l.session_title,
      sessionKind: l.session_kind,
      deviceName: l.device_name,
      since: iso(l.acquired_at) as string,
      boxReturned,
    });
  }

  for (const c of input.claims) {
    if (!leaseIsWorkInProgress(c.reading.verdict) || c.reading.holder === null) continue;
    holdOn({ ...ref(c.issue), status: c.issue.status }).holders.push({
      by: 'claim',
      holder: c.reading.holder,
      renewedAt: leaseText(c.lease, 'renewedAt'),
      expiresAt: c.reading.expiresAt ? c.reading.expiresAt.toISOString() : null,
      next: leaseText(c.lease, 'next'),
    });
  }

  for (const p of input.persons) {
    holdOn({ ...ref(p.issue), status: p.issue.status }).holders.push(p.holder);
  }

  const sessions = input.sessions.map(
    (s): LiveSession => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      jobType: s.job_type ?? null,
      skillName: s.skill_name ?? null,
      status: s.status,
      runtimeState: s.runtime_state,
      deviceId: s.device_id,
      deviceName: s.device_name,
      parentSessionId: s.parent_session_id,
      startedAt: iso(s.started_at),
      lastHeartbeatAt: iso(s.last_heartbeat_at),
      createdAt: iso(s.created_at) as string,
      issues: issuesOf.get(s.id) ?? [],
      report: reportOf.get(s.id) ?? null,
      silenceLimitMs: silenceLimitFrom(
        s.silence_deadline ?? null,
        s.last_heartbeat_at,
        s.started_at,
      ),
    }),
  );

  const runningChats = input.runningChats.map((c) => ({ id: c.id, deviceId: c.device_id }));
  return { sessions, holds: [...held.values()], runningChats, readAt: input.now.toISOString() };
}

const listOf = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

const terminalSessions = listOf(terminalAgentSessionStatuses);
const terminalIssues = listOf(ISSUE_TERMINAL_STATUSES);
const parkStatuses = listOf(HUMAN_PARK_STATUSES);

/** The newest move onto `on_hold`: its time and the reason given, which is all an `on_hold` records. */
async function onHoldMove(issueId: string): Promise<{ at: string | null; reason: string | null }> {
  const rows = (await db.execute(sql`
    SELECT created_at, reason
      FROM kernel_transitions
     WHERE entity = 'issue' AND entity_id = ${issueId}::uuid AND to_status = 'on_hold'
     ORDER BY created_at DESC
     LIMIT 1
  `)) as unknown as Array<{ created_at: Date | string; reason: string | null }>;
  const row = rows[0];
  return { at: row ? iso(row.created_at) : null, reason: row?.reason ?? null };
}

/** An archived issue is neither held nor worked, so no read here answers one. */
const liveIssue = sql.join(issueArchiveSide(false), sql` AND `);

/** Read one project's sessions and holds. The caller has already checked membership. */
export async function readSessionsAndHolds(
  projectId: string,
  now: Date = new Date(),
): Promise<SessionsAndHolds> {
  const [project] = (await db.execute(sql`
    SELECT issue_prefix FROM projects WHERE id = ${projectId}::uuid
  `)) as unknown as Array<{ issue_prefix: string | null }>;

  const sessions = (await db.execute(sql`
    SELECT s.id, s.kind, s.title, s.metadata ->> 'jobType' AS job_type,
           s.metadata ->> 'skillName' AS skill_name,
           s.status, s.runtime_state, s.device_id, d.name AS device_name,
           s.parent_session_id, s.started_at, s.last_heartbeat_at, s.created_at
      FROM agent_sessions s
      LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.project_id = ${projectId}::uuid
       AND ${liveSessionWhere}
     ORDER BY s.created_at
  `)) as unknown as SessionRow[];

  // Read in the same request as the sessions, so a box's count never mixes two moments (ISS-1228).
  const runningChats = (await db.execute(sql`
    SELECT s.id, s.device_id
      FROM agent_sessions s
     WHERE s.project_id = ${projectId}::uuid AND s.kind = 'chat' AND s.status = 'running'
     ORDER BY s.created_at
  `)) as unknown as Array<{ id: string; device_id: string | null }>;

  const ids = sessions.map((s) => s.id);
  const ledger = await loadLedgerRows(ids);
  const deadlines = await loadSilenceDeadlines(ids);
  for (const s of sessions) s.silence_deadline = deadlines.get(s.id) ?? null;

  const leases = (await db.execute(
    heldIssueRowsSql(
      sql`issues.project_id = ${projectId}::uuid AND s.status NOT IN (${terminalSessions}) AND ${liveIssue}`,
    ),
  )) as unknown as LeaseRow[];

  const claimRows = (await db.execute(sql`
    SELECT id, iss_seq, title, status, session_context -> 'lease' AS lease
      FROM issues
     WHERE project_id = ${projectId}::uuid
       AND status NOT IN (${terminalIssues})
       AND ${liveIssue}
       AND session_context -> 'lease' IS NOT NULL
       AND jsonb_typeof(session_context -> 'lease') <> 'null'
     ORDER BY iss_seq
  `)) as unknown as Array<IssueRow & { lease: unknown }>;
  const fanout = await holderFanout(
    claimRows.map((r) => r.lease),
    now,
  );
  const claims = claimRows.map((r) => ({
    issue: r,
    lease: r.lease,
    reading: readClaim(r.lease, now, fanout),
  }));

  const parked = (await db.execute(sql`
    SELECT id, iss_seq, title, status
      FROM issues
     WHERE project_id = ${projectId}::uuid
       AND status IN (${parkStatuses})
       AND ${liveIssue}
     ORDER BY iss_seq
  `)) as unknown as IssueRow[];
  const persons = await Promise.all(
    parked.map(async (issue): Promise<PersonInput> => {
      if (issue.status === 'on_hold') {
        const move = await onHoldMove(issue.id);
        return {
          issue,
          holder: { by: 'person', status: 'on_hold', owes: null, since: move.at, why: move.reason },
        };
      }
      const status = issue.status as IssueStatus;
      return { issue, holder: personHolderFromPark(status, await loadIssuePark(issue.id)) };
    }),
  );

  return projectSessionsAndHolds({
    prefix: project?.issue_prefix ?? null,
    sessions,
    ledger,
    leases,
    claims,
    persons,
    runningChats,
    now,
  });
}
