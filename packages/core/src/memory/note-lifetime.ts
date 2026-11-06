// ISS-1063: a note is a lead, never a decision in force, so it does not outlive what it was for.
//  - A note written for an issue (`metadata.issueId`, or `metadata.about` naming its key) retires
//    when that issue reaches `closed` or `dropped`, unless someone verified it after its last write.
//  - A note naming no issue retires once its last write and its last check are both older than the
//    project's note window (policy `memory.noteWindowDays`, default `MEMORY_NOTE_WINDOW_DAYS`).
//  - Every hit a search answers carries its standing: `verified` when checked after its last write
//    and within that window, `unverified` otherwise.
// Retiring archives the row, as decay does: the row stays readable on the retired list with the
// reason on `metadata.archivedBy`, and nothing is deleted here.

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { MEMORY_NOTE_WINDOW_DAYS, type MemoryStanding } from '@forge/contracts/memory';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { readEffectivePolicy } from '../project-config/index.js';
import { memoryIssueReads } from './ports.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `metadata.archivedBy` a note retired with its issue carries: the issue and where it ended. */
export const noteIssueEnded = (key: string, status: string) =>
  `note: written for ${key}, which reached ${status}, and not verified since`;

/** The `metadata.archivedBy` a note naming no issue carries once its window passed unchecked. */
export const noteExpired = (days: number) =>
  `note: names no issue and was not verified in ${days} days`;

/** The project's note window in days: its policy's `memory.noteWindowDays`, else the default. */
export async function noteWindowDays(projectId: string): Promise<number> {
  const policy = await readEffectivePolicy(projectId);
  return policy?.document.memory?.noteWindowDays ?? MEMORY_NOTE_WINDOW_DAYS;
}

/** Checked after its last write: a rewrite after the check makes the body unchecked again. */
const verifiedSinceWritten: SQL = sql`(${memories.lastVerifiedAt} IS NOT NULL AND ${memories.lastVerifiedAt} >= ${memories.updatedAt})`;

const namesNoIssue: SQL = sql`(coalesce(${memories.metadata}->>'issueId', '') = '' AND coalesce(${memories.metadata}->>'about', '') = '')`;

/** A live note: not archived, `source = 'note'`. */
const liveNote = (projectId?: string) =>
  and(
    eq(memories.source, 'note'),
    isNull(memories.archivedAt),
    ...(projectId ? [eq(memories.projectId, projectId)] : []),
  );

/**
 * What a hit stands as: `verified` when it was checked after its last write (`verifiedAt` at or past
 * `asOf`) and within `windowDays` of `now`; `unverified` otherwise.
 */
export function standingOf(
  hit: { verifiedAt: Date | null; asOf: Date },
  windowDays: number,
  now: number = Date.now(),
): MemoryStanding {
  const v = hit.verifiedAt?.getTime();
  if (v === undefined) return 'unverified';
  return v >= hit.asOf.getTime() && v >= now - windowDays * DAY_MS ? 'verified' : 'unverified';
}

interface EndedIssue {
  projectId: string;
  /** The issue's id, when known: matched against `metadata.issueId`. */
  id: string | null;
  /** Its key as the project shows it now (`ISS-12`); the sequence is what `metadata.about` is matched on. */
  key: string;
  seq: number;
  status: string;
}

/** Archive the project's live, unverified notes written for this issue; how many were. */
async function retireNotesOf(issue: EndedIssue): Promise<number> {
  const aboutIt = sql`(${memories.metadata}->>'about') ~* ${`^[A-Z][A-Z0-9]{0,15}-${issue.seq}$`}`;
  const byId = issue.id ? sql`(${memories.metadata}->>'issueId') = ${issue.id}` : sql`false`;
  const rows = await db
    .update(memories)
    .set({
      archivedAt: sql`now()`,
      metadata: sql`${memories.metadata} || jsonb_build_object('archivedBy', ${noteIssueEnded(issue.key, issue.status)}::text)`,
    })
    .where(
      and(
        liveNote(issue.projectId),
        sql`(${byId} OR ${aboutIt})`,
        sql`NOT ${verifiedSinceWritten}`,
      ),
    )
    .returning({ id: memories.id });
  return rows.length;
}

const KEY = /^[A-Z][A-Z0-9]{0,15}-([1-9]\d{0,8})$/i;
const seqOf = (key: string): number | null => {
  const m = KEY.exec(key);
  return m ? Number(m[1]) : null;
};

/** A move of an issue to `closed` or `dropped` retires the notes written for it. */
export async function retireNotesForMovedIssue(move: {
  projectId: string;
  id: string;
  to: string;
}): Promise<number> {
  if (!ISSUE_TERMINAL_STATUSES.includes(move.to as (typeof ISSUE_TERMINAL_STATUSES)[number])) {
    return 0;
  }
  const key = (await memoryIssueReads().displayIds([move.id])).get(move.id);
  const seq = key ? seqOf(key) : null;
  if (!key || seq === null) return 0;
  return retireNotesOf({ projectId: move.projectId, id: move.id, key, seq, status: move.to });
}

/**
 * The sweep's half of the issue rule: notes written for an issue that ended while nothing was
 * listening (before ISS-1063, or a delivery that never came) retire on the next pass.
 */
async function retireNotesOfEndedIssues(): Promise<number> {
  const rows = await db
    .selectDistinct({
      projectId: memories.projectId,
      issueId: sql<string | null>`nullif(${memories.metadata}->>'issueId', '')`,
      about: sql<string | null>`nullif(${memories.metadata}->>'about', '')`,
    })
    .from(memories)
    .where(and(liveNote(), sql`NOT ${namesNoIssue}`, sql`NOT ${verifiedSinceWritten}`));
  const reads = memoryIssueReads();
  const keys = await reads.displayIds([
    ...new Set(rows.flatMap((r) => (r.issueId ? [r.issueId] : []))),
  ]);
  const byProject = new Map<string, Map<number, string | null>>();
  for (const r of rows) {
    const key = (r.issueId ? keys.get(r.issueId) : undefined) ?? r.about;
    const seq = key ? seqOf(key) : null;
    if (seq === null) continue;
    const seqs = byProject.get(r.projectId) ?? new Map<number, string | null>();
    if (!seqs.get(seq)) seqs.set(seq, r.issueId && keys.has(r.issueId) ? r.issueId : null);
    byProject.set(r.projectId, seqs);
  }
  let retired = 0;
  for (const [projectId, seqs] of byProject) {
    const standings = await reads.issueStandings(projectId, [...seqs.keys()]);
    const { active } = await reads.issuePrefixes(projectId);
    for (const [seq, id] of seqs) {
      const status = standings.get(seq)?.status;
      if (!status || !(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status)) continue;
      const key = (id ? keys.get(id) : undefined) ?? `${active ?? 'ISS'}-${seq}`;
      retired += await retireNotesOf({ projectId, id, key, seq, status });
    }
  }
  return retired;
}

/** Notes naming no issue whose last write and last check are both older than their project's window. */
async function expireIssuelessNotes(now: number): Promise<number> {
  // the shortest window a policy may set is a day: a note written since cannot be due anywhere
  const projects = await db
    .selectDistinct({ projectId: memories.projectId })
    .from(memories)
    .where(
      and(
        liveNote(),
        namesNoIssue,
        sql`${memories.updatedAt} < ${sqlTimestamp(new Date(now - DAY_MS))}`,
      ),
    );
  let expired = 0;
  for (const { projectId } of projects) {
    const days = await noteWindowDays(projectId);
    const cutoff = sqlTimestamp(new Date(now - days * DAY_MS));
    const rows = await db
      .update(memories)
      .set({
        archivedAt: sql`now()`,
        metadata: sql`${memories.metadata} || jsonb_build_object('archivedBy', ${noteExpired(days)}::text)`,
      })
      .where(
        and(
          liveNote(projectId),
          namesNoIssue,
          sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.updatedAt})) < ${cutoff}`,
        ),
      )
      .returning({ id: memories.id });
    expired += rows.length;
  }
  return expired;
}

/** The note rules' pass, run with decay: notes of ended issues, then issue-less notes past their window. */
export async function retireLapsedNotes(
  now: number = Date.now(),
): Promise<{ issueEnded: number; expired: number }> {
  const issueEnded = await retireNotesOfEndedIssues();
  const expired = await expireIssuelessNotes(now);
  return { issueEnded, expired };
}
