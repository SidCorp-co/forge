/**
 * What a mark said, as the agent said it, and who said it (ISS-1017).
 *
 * Whether work is done is the agent's call, not core's (owner, 2026-11-05,
 * `owner-2026-11-05-done-is-the-agents-call`). So the mark writer (`merge-marker.ts`) refuses no mark
 * for the evidence it lacks: whatever evidence the call names — a commit, a target, a landing,
 * artifacts, the paths a box read, a live reading, a note — is recorded on the mark's trail record as
 * given, beside the actor and the run that held the issue, and a mark naming none records that.
 * What the repository said of a named commit rides beside it as a reading (`commit-landing.ts`).
 * The issue's detail reads them back here, so the mark is read where it was written.
 */

import type { LandingArtifact, LiveReading } from '@forge/contracts/landing-artifacts';
import type { ActorAgency } from '@forge/contracts/permissions';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import type { CommitReading } from './commit-landing.js';
import { MARK_RECORD, UNMARK_RECORD } from './mark-trail.js';
import { runSessionHoldersOf } from './run-holder.js';

/** The evidence a mark named, each field only where the call sent it. */
export interface MarkSaid {
  commit?: string;
  target?: string;
  landing?: string;
  artifacts?: LandingArtifact[];
  changedPaths?: { commit: string; paths: number };
  liveReading?: LiveReading;
  note?: string;
  mergedAt?: string;
  contracts?: string[];
  adoptions?: string[];
}

/** Who marked: the actor, and the run session holding the issue on the caller's box, where one does. */
export interface MarkSaidBy {
  type: string;
  id: string;
  agency: ActorAgency;
  run: string | null;
}

/** The evidence a mark's call named, as named; `{}` where it names none. */
export function saidOf(args: {
  commit?: string | undefined;
  target?: string | undefined;
  landing?: string | undefined;
  artifacts?: readonly LandingArtifact[] | undefined;
  changedPaths?: { commit: string; changes: readonly unknown[] } | undefined;
  liveReading?: LiveReading | undefined;
  note?: string | undefined;
  mergedAt?: Date | null | undefined;
  contracts?: readonly string[] | undefined;
  adoptions?: readonly string[] | undefined;
}): MarkSaid {
  return {
    ...(args.commit ? { commit: args.commit } : {}),
    ...(args.target ? { target: args.target } : {}),
    ...(args.landing ? { landing: args.landing } : {}),
    ...(args.artifacts?.length ? { artifacts: [...args.artifacts] } : {}),
    ...(args.changedPaths
      ? {
          changedPaths: {
            commit: args.changedPaths.commit,
            paths: args.changedPaths.changes.length,
          },
        }
      : {}),
    ...(args.liveReading ? { liveReading: args.liveReading } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.mergedAt ? { mergedAt: args.mergedAt.toISOString() } : {}),
    ...(args.contracts?.length ? { contracts: [...args.contracts] } : {}),
    ...(args.adoptions?.length ? { adoptions: [...args.adoptions] } : {}),
  };
}

/** The sentence saying what the mark named and what the repository said, beside its kind's. */
export function saidSentence(said: MarkSaid, reading: CommitReading | null): string {
  const parts = [
    said.commit ? `commit ${said.commit}` : null,
    said.target ? `target \`${said.target}\`` : null,
    said.landing ? `landing ${said.landing}` : null,
    said.artifacts
      ? `${said.artifacts.length} artifact(s): ${said.artifacts.map((a) => `\`${a.surface}\` ${a.ref} (${a.change})`).join(', ')}`
      : null,
    said.changedPaths
      ? `${said.changedPaths.paths} path(s) a box read at ${said.changedPaths.commit}`
      : null,
    said.liveReading
      ? `a live reading of ${said.liveReading.url} answering ${said.liveReading.status}`
      : null,
  ].filter((p): p is string => p !== null);
  const named =
    parts.length > 0
      ? `It names ${parts.join('; ')}, recorded as the marker gave them.`
      : "It names no evidence: no commit, target, landing, artifact or live reading. It stands on the marker's word.";
  return reading ? `${named} ${readingSentence(reading)}` : named;
}

function readingSentence(reading: CommitReading): string {
  if (reading.outcome === 'found') {
    return `The repository was read: ${reading.repository} holds commit ${reading.commit} on ${reading.branch} as this issue's.`;
  }
  return `The repository was read and did not vouch for commit ${reading.commit} (${reading.outcome}, ${reading.code}: ${reading.detail}); a reading, which refuses nothing.`;
}

/** The run session holding the issue on the caller's box, or null where none does or no box called. */
export async function callerRunOf(
  executor: Pick<Tx, 'execute'>,
  issueId: string,
  box: string | null,
): Promise<string | null> {
  if (!box) return null;
  const sessions = await runSessionHoldersOf(executor, issueId);
  return sessions.find((s) => s.deviceId === box)?.runId ?? null;
}

/** The issue's current mark as its trail record holds it: what it said, who said it, the reading. */
export interface MarkSaidRecord {
  at: string;
  by: { id: string; name: string | null; agency: ActorAgency };
  run: string | null;
  said: MarkSaid;
  commitReading: CommitReading | null;
}

/**
 * The current mark's record for each issue: the newest stamped mark, where no unmark came after it.
 * A mark recorded before ISS-1017 has no `said` and is absent, as is an unmarked issue.
 */
export async function markSaidOf(
  issueIds: readonly string[],
  executor: Pick<Tx, 'execute'> = db,
): Promise<Map<string, MarkSaidRecord>> {
  const out = new Map<string, MarkSaidRecord>();
  if (issueIds.length === 0) return out;
  const found = (await executor.execute(sql`
    SELECT cur.issue_id, cur.created_at AS at, cur.actor_id, cur.actor_agency, cur.payload,
           u.display_name AS name
      FROM (
        SELECT DISTINCT ON (a.issue_id) a.issue_id, a.action, a.created_at, a.actor_id,
               a.actor_agency, a.payload
          FROM activity_log a
         WHERE a.issue_id IN (${sql.join(
           issueIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
           AND ((a.action = ${MARK_RECORD} AND (a.payload ->> 'stamped')::boolean)
                OR a.action = ${UNMARK_RECORD})
         ORDER BY a.issue_id, a.created_at DESC, (a.action = ${MARK_RECORD}) ASC
      ) cur
      LEFT JOIN users u ON u.id = cur.actor_id
     WHERE cur.action = ${MARK_RECORD} AND cur.payload ? 'said'
  `)) as unknown as Array<{
    issue_id: string;
    at: Date | string;
    actor_id: string;
    actor_agency: ActorAgency;
    payload: { said: MarkSaid; run?: string | null; commitReading?: CommitReading | null };
    name: string | null;
  }>;
  for (const r of found) {
    out.set(r.issue_id, {
      at: new Date(r.at).toISOString(),
      by: { id: r.actor_id, name: r.name, agency: r.actor_agency },
      run: r.payload.run ?? null,
      said: r.payload.said,
      commitReading: r.payload.commitReading ?? null,
    });
  }
  return out;
}
