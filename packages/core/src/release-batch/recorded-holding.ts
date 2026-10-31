/**
 * Whether a later commit holds an issue's landing, answered from Forge's own records and never from
 * the host (owner, 2026-10-29: agents record, Forge never infers). The read paths that weigh a pass
 * at a later build on its landing (requirement coverage's `laterHoldersOf`, the steward's
 * `aheadBuildsOf`) asked GitLab's compare per pair on every read: 242 calls a minute from dev core,
 * three in four answered 429 under `burst_traffic_per_user_free_plan` (2026-10-30). A later commit
 * holds the landing here where an issue's merge mark records a landing at it, on the branch the
 * landing's own mark names, at or after it; otherwise it is unread, naming the record that is missing.
 * A mark's commit is the one Forge observed (`merged_commit_sha`), else the one the current mark
 * claimed (`markedCommitsOf`): both are a landing an agent recorded. So is every stamped mark an issue
 * carried before its current one (`mark-trail.ts`, `issue.mergeMarked`), at the time it was recorded
 * and on the branch it named (ISS-845): a fix round re-marks its issue at the new landing, and the
 * round before it landed where its own mark said, which no later mark moves.
 */

import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { MARK_RECORD, markedCommitsOf } from '../issues/index.js';
import { type AncestryPair, pairKey } from '../runners/index.js';
import type { Holding } from './landed-build.js';

interface Mark {
  at: Date;
  target: string | null;
}

const short = (sha: string) => sha.slice(0, 12);

/** Each pair's answer (`commit` the landing, `release` the later commit) from the merge marks recorded on the project. */
export async function recordedHolding(
  projectId: string,
  pairs: readonly AncestryPair[],
): Promise<Map<string, Holding>> {
  const out = new Map<string, Holding>();
  if (pairs.length === 0) return out;
  const shas = [
    ...new Set(pairs.flatMap((p) => [p.commit, p.release]).map((s) => s.toLowerCase())),
  ];
  const marks = await landingMarks(projectId, shas);
  for (const p of pairs) {
    const landing = p.commit.toLowerCase();
    const later = p.release.toLowerCase();
    if (landing === later) {
      out.set(pairKey(p), true);
      continue;
    }
    const own = marks.get(landing);
    const at = marks.get(later);
    const why = !own
      ? `no merge mark records the landing ${short(landing)}, so no record places ${short(later)} after it`
      : !at
        ? `no merge mark records a landing at ${short(later)}, so nothing on record says it holds ${short(landing)}; a landing recorded there would`
        : at.target !== own.target
          ? `${short(later)} landed on \`${at.target ?? 'no recorded branch'}\` and ${short(landing)} on \`${own.target ?? 'no recorded branch'}\``
          : at.at < own.at
            ? `${short(later)} was recorded landing before ${short(landing)}`
            : null;
    out.set(pairKey(p), why === null ? true : { unread: why });
  }
  return out;
}

/** The newest merged issue's mark at each of `shas` on the project: its time and branch. */
async function landingMarks(
  projectId: string,
  shas: readonly string[],
): Promise<Map<string, Mark>> {
  const among = sql.join(
    shas.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT i.id::text AS id, i.merged_at AS at,
           i.merged_target AS target
      FROM issues i
     WHERE i.project_id = ${projectId} AND i.merged_at IS NOT NULL
       AND (lower(i.merged_commit_sha) IN (${among})
            OR (i.merged_commit_sha IS NULL AND EXISTS (
                  SELECT 1 FROM activity_log a
                   WHERE a.issue_id = i.id AND a.action = ${MARK_RECORD}
                     AND lower(a.payload ->> 'commit') IN (${among}))))
  `)) as unknown as Array<{ id: string; at: Date | string; target: string | null }>;
  const named = await markedCommitsOf(rows.map((r) => r.id));
  const marks = new Map<string, Mark>();
  const keepNewest = (sha: string, mark: Mark) => {
    const before = marks.get(sha);
    if (!before || before.at < mark.at) marks.set(sha, mark);
  };
  for (const r of rows) {
    const sha = named.get(r.id)?.sha;
    if (sha === undefined || !shas.includes(sha)) continue;
    keepNewest(sha, { at: new Date(r.at), target: r.target });
  }
  for (const t of await trailMarks(projectId, among)) {
    keepNewest(t.sha.toLowerCase(), { at: new Date(t.at), target: t.target });
  }
  return marks;
}

/** Every stamped mark the project's issues recorded at one of `among`, current or since superseded. */
async function trailMarks(projectId: string, among: SQL) {
  return (await db.execute(sql`
    SELECT lower(a.payload ->> 'commit') AS sha, a.created_at AS at, a.payload ->> 'target' AS target
      FROM activity_log a
      JOIN issues i ON i.id = a.issue_id
     WHERE i.project_id = ${projectId} AND a.action = ${MARK_RECORD}
       AND (a.payload ->> 'stamped')::boolean
       AND lower(a.payload ->> 'commit') IN (${among})
  `)) as unknown as Array<{ sha: string; at: Date | string; target: string | null }>;
}
