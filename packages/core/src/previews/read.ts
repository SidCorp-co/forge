// The previews module's reads: its own rows, the record REST answers, and the run whose worktree
// an issue's preview serves.

import type { PreviewRecord, PreviewState } from '@forge/contracts/preview';
import { TERMINAL_AGENT_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PreviewRow, previews } from '../db/schema-previews.js';
import { type PreviewSite, previewOrigin } from './domain.js';
import { OPEN_STATES } from './rules.js';

export async function previewById(id: string): Promise<PreviewRow | null> {
  const [row] = await db.select().from(previews).where(eq(previews.id, id)).limit(1);
  return row ?? null;
}

export async function previewBySlug(slug: string): Promise<PreviewRow | null> {
  const [row] = await db.select().from(previews).where(eq(previews.slug, slug)).limit(1);
  return row ?? null;
}

export async function latestPreviewOfIssue(issueId: string): Promise<PreviewRow | null> {
  const [row] = await db
    .select()
    .from(previews)
    .where(eq(previews.issueId, issueId))
    .orderBy(desc(previews.createdAt))
    .limit(1);
  return row ?? null;
}

export async function openPreviewOfSession(sessionId: string): Promise<PreviewRow | null> {
  const [row] = await db
    .select()
    .from(previews)
    .where(and(eq(previews.sessionId, sessionId), inArray(previews.state, [...OPEN_STATES])))
    .limit(1);
  return row ?? null;
}

/** The latest approved preview of an issue, with what its approver saw: the fast lane reads it. */
export async function approvedPreviewOf(issueId: string) {
  const [row] = await db
    .select()
    .from(previews)
    .where(and(eq(previews.issueId, issueId), eq(previews.state, 'approved')))
    .orderBy(desc(previews.closedAt))
    .limit(1);
  if (!row?.approvedPatchId || !row.closedAt) return null;
  return {
    previewId: row.id,
    patchId: row.approvedPatchId,
    files: row.approvedFiles ?? [],
    lane: row.laneDecision,
    approvedBy: row.approvedBy,
    approvedAt: row.closedAt.toISOString(),
  };
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** The record as REST answers it and the issue and chat show it. */
export function previewView(row: PreviewRow, site: PreviewSite): PreviewRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    issueId: row.issueId,
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    url: `${previewOrigin(site, row.slug)}/`,
    state: row.state,
    reason: row.reason,
    detail: row.detail,
    command: row.command,
    port: row.port,
    idleMinutes: row.idleMinutes,
    approvedPatchId: row.approvedPatchId,
    approvedBy: row.approvedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    liveAt: iso(row.liveAt),
    lastViewedAt: iso(row.lastViewedAt),
    closedAt: iso(row.closedAt),
  };
}

/** The project an issue belongs to, or null where there is no such issue. */
export async function issueProjectOf(issueId: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`SELECT project_id FROM issues WHERE id = ${issueId}::uuid`,
  )) as unknown as { project_id: string }[];
  return rows[0]?.project_id ?? null;
}

export interface LiveRun {
  sessionId: string;
  deviceId: string;
}

/**
 * The run working an issue that still holds a worktree on its box: a queued or running session,
 * bound to the issue on either session lane (the job's `metadata.issueId`, the run session's lease),
 * whose box reports the run's checkout still on disk. The latest such run, or null.
 */
export async function liveRunOfIssue(issueId: string): Promise<LiveRun | null> {
  const rows = (await db.execute(sql`
    SELECT s.id AS session_id, s.device_id
      FROM issues i
      JOIN agent_sessions s ON s.project_id = i.project_id
      JOIN device_run_ledger l ON l.session_id = s.id AND l.device_id = s.device_id
     WHERE i.id = ${issueId}::uuid
       AND s.status IN ('queued', 'running')
       AND l.worktree_gone_at IS NULL
       AND l.session_terminal_at IS NULL
       AND (s.metadata->>'issueId' = i.id::text
            OR EXISTS (SELECT 1 FROM issue_leases il
                        WHERE il.session_id = s.id AND il.project_id = i.project_id
                          AND il.issue_key = 'ISS-' || i.iss_seq)) -- ISS-992:canonical
     ORDER BY l.observed_at DESC
     LIMIT 1
  `)) as unknown as { session_id: string; device_id: string }[];
  const row = rows[0];
  return row ? { sessionId: row.session_id, deviceId: row.device_id } : null;
}

/** Open previews whose run ended or whose box reports the worktree gone: each is abandoned. */
export async function previewsWhoseRunEnded(): Promise<{ id: string; why: string }[]> {
  const rows = (await db.execute(sql`
    SELECT p.id, s.status,
           (SELECT bool_or(l.worktree_gone_at IS NOT NULL OR l.session_terminal_at IS NOT NULL)
              FROM device_run_ledger l WHERE l.session_id = p.session_id) AS gone
      FROM previews p
      JOIN agent_sessions s ON s.id = p.session_id
     WHERE p.state IN ('starting', 'live', 'idle_closed')
  `)) as unknown as { id: string; status: string; gone: boolean | null }[];
  return rows
    .filter(
      (r) =>
        (TERMINAL_AGENT_SESSION_STATUSES as readonly string[]).includes(r.status) ||
        r.gone === true,
    )
    .map((r) => ({
      id: r.id,
      why:
        r.gone === true
          ? 'the run holding the worktree ended: its box reports the checkout released'
          : `the run holding the worktree ended: its session is ${r.status}`,
    }));
}

/** Previews in one of `states`, for the sweep. */
export function previewsIn(states: readonly PreviewState[]): Promise<PreviewRow[]> {
  return db
    .select()
    .from(previews)
    .where(inArray(previews.state, [...states]));
}
