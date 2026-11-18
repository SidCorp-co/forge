// A production deployed outside Forge by the door it names (ISS-851) cuts nothing: its release is the
// agent's record of that door's deploy. Every door but the record answers that, and only over a roster
// that still holds an issue a record takes (ISS-1296): a named issue a shipped release already holds is
// the claim's refusal to name, never a record to ask for.
//
// epod 1.50.0 (FB-719) waited on its master's record with only closed issues on its roster, each taken
// by an earlier record and withdrawn by its reopen; its master read "nothing to record". A record does
// carry such an issue, as it stands (`recorded.ts:closeRecorded`), so the reason says which closed issues
// it carries and the release each was taken by before its reopen.

import { type Said, say } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf, uuidArray } from '../db/raw-sql.js';
import { issueDisplayIds, waitingForReleaseSql } from '../issues/index.js';
import { blocker, evaluate } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';

/** A closed issue a record still carries, and the shipped release that took it before its reopen. */
export interface ClosedCarried {
  issueId: string;
  displayId: string;
  /** The newest shipped release whose roster took it; null where no release ever has. */
  takenBy: string | null;
}

/**
 * Of `issueIds` on the project, those still waiting for a release, with the status each stands at and,
 * for each at `closed`, the newest shipped release whose roster took it (`issueIds` it closed, or
 * `rosterClosed`) and no correction moved off: one its reopen has since withdrawn, since the issue
 * waits again (`issues/release-evidence.ts:holdingReleaseRunsSql`).
 */
async function waitingOf(projectId: string, issueIds: readonly string[]) {
  if (issueIds.length === 0) return [];
  const listed = (key: string) => sql`(r.release_roster -> ${key}) @> to_jsonb(i.id::text)`;
  return rowsOf<{ id: string; status: string; taken_by: string | null }>(
    await db.execute(sql`
      SELECT i.id::text AS id, i.status,
             (SELECT r.release_version FROM pipeline_runs r
               WHERE r.project_id = i.project_id
                 AND r.release_version IS NOT NULL AND r.release_released_at IS NOT NULL
                 AND ((${listed('issueIds')} AND NOT ${listed('rosterUnclosed')}) OR ${listed('rosterClosed')})
                 AND NOT ${listed('rosterSuperseded')}
               ORDER BY r.release_released_at DESC LIMIT 1) AS taken_by
        FROM issues i
       WHERE i.project_id = ${projectId}::uuid AND i.id = ANY(${uuidArray([...issueIds])})
         AND ${waitingForReleaseSql(sql`i`)}`),
  );
}

/**
 * `RELEASE_DEPLOYED_OUTSIDE` where any of `issueIds` still waits for a release, naming each closed one
 * it carries; nothing where none does, so a draft or a cut over issues every record already took asks
 * no record. A read that fails is this check unevaluated, by name.
 */
export async function deployedOutsideBlocker(
  projectId: string,
  issueIds: readonly string[],
  out: ReleaseBlocker[],
): Promise<void> {
  const read = await evaluate(
    'deployed-outside',
    async () => {
      const rows = await waitingOf(projectId, issueIds);
      const closed = rows.filter((r) => r.status === 'closed');
      const shown = closed.length > 0 ? await issueDisplayIds(closed.map((r) => r.id)) : new Map();
      const carried: ClosedCarried[] = closed.map((r) => ({
        issueId: r.id,
        displayId: shown.get(r.id) ?? r.id,
        takenBy: r.taken_by,
      }));
      return { waiting: rows.length, carried };
    },
    out,
  );
  if (!read || read.waiting === 0) return;
  out.push(
    blocker(
      'RELEASE_DEPLOYED_OUTSIDE',
      read.carried.length > 0 ? { closed: read.carried } : undefined,
    ),
  );
}

const carriedOf = (d: Record<string, unknown> | undefined): ClosedCarried[] =>
  Array.isArray(d?.closed) ? (d.closed as ClosedCarried[]) : [];

/** The reason's plain sentence: the closed issues its record carries, each with the release that took it. */
export function deployedOutsideSaid(d: Record<string, unknown> | undefined): Said {
  const carried = carriedOf(d);
  if (carried.length === 0) return say('standing.gate.deployedOutside');
  return say('standing.gate.deployedOutsideCarries', {
    closed: carried.map((c) =>
      c.takenBy
        ? say('standing.gate.closedWithdrawn', { key: c.displayId, v: c.takenBy })
        : say('standing.gate.subject.keys', { keys: c.displayId }),
    ),
  });
}
