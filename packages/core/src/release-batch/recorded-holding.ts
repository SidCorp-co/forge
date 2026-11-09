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
import { uuidArray } from '../db/raw-sql.js';
import { idOfParts, memoizedPerId, partsOf } from '../db/read-memo.js';
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

/**
 * A pair neither the marks nor a source host answer Forge kept (`served_ancestry`) places: what the
 * marks said, and the answer that is missing. The marks answer only on one branch, so a landing on
 * the branch work lands on and a later commit on the branch a promotion carries it to are placed
 * only by the host's answer, which the pass that reads what a project serves asks once and keeps
 * (`served-ancestry.ts`, ISS-1169); a read never asks it.
 */
export function unkept(marked: Holding | undefined, pair: AncestryPair): { unread: string } {
  const said = typeof marked === 'object' ? `${marked.unread}; ` : '';
  const missing = `no answer of the source host is kept on whether ${short(pair.release)} holds ${short(pair.commit)} (\`served_ancestry\`): the pass that reads what this project serves asks it once and keeps it`;
  return { unread: `${said}${missing}` };
}

/**
 * The newest merged issue's mark at each of `shas` on the project: its time and branch. A mark at a
 * commit is the project's own, so every project's asks before the quiet point are one read
 * (`db/read-memo.ts:memoizedPerId`): the issues and trail marks of all of them in two statements,
 * each kept only for the project and commit it was asked for (ISS-1070 r10: a person's projects that
 * record landings each sent their own, twice a read).
 */
async function landingMarks(
  projectId: string,
  shas: readonly string[],
): Promise<Map<string, Mark>> {
  const held = await memoizedPerId(
    'landingMarks',
    shas.map((sha) => idOfParts(projectId, sha)),
    marksAt,
  );
  return new Map([...held].map(([key, mark]) => [partsOf(key)[1] as string, mark]));
}

/** Each asked project and commit's (`idOfParts`) newest mark, from its issues and their trails. */
async function marksAt(keys: readonly string[]): Promise<Map<string, Mark>> {
  const asked = new Set(keys);
  const projects = [...new Set(keys.map((k) => partsOf(k)[0] as string))];
  const among = sql.join(
    [...new Set(keys.map((k) => partsOf(k)[1] as string))].map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT i.id::text AS id, i.project_id::text AS project_id, i.merged_at AS at,
           i.merged_target AS target
      FROM issues i
     WHERE i.project_id = ANY(${uuidArray(projects)}) AND i.merged_at IS NOT NULL
       AND (lower(i.merged_commit_sha) IN (${among})
            OR (i.merged_commit_sha IS NULL AND EXISTS (
                  SELECT 1 FROM activity_log a
                   WHERE a.issue_id = i.id AND a.action = ${MARK_RECORD}
                     AND lower(a.payload ->> 'commit') IN (${among}))))
  `)) as unknown as Array<{
    id: string;
    project_id: string;
    at: Date | string;
    target: string | null;
  }>;
  const named = await markedCommitsOf(rows.map((r) => r.id));
  const marks = new Map<string, Mark>();
  const keepNewest = (key: string, mark: Mark) => {
    if (!asked.has(key)) return;
    const before = marks.get(key);
    if (!before || before.at < mark.at) marks.set(key, mark);
  };
  for (const r of rows) {
    const sha = named.get(r.id)?.sha;
    if (sha === undefined) continue;
    keepNewest(idOfParts(r.project_id, sha), { at: new Date(r.at), target: r.target });
  }
  for (const t of await trailMarks(projects, among)) {
    keepNewest(idOfParts(t.project_id, t.sha.toLowerCase()), {
      at: new Date(t.at),
      target: t.target,
    });
  }
  return marks;
}

/** Every stamped mark the projects' issues recorded at one of `among`, current or since superseded. */
async function trailMarks(projects: readonly string[], among: SQL) {
  return (await db.execute(sql`
    SELECT i.project_id::text AS project_id, lower(a.payload ->> 'commit') AS sha, a.created_at AS at,
           a.payload ->> 'target' AS target
      FROM activity_log a
      JOIN issues i ON i.id = a.issue_id
     WHERE i.project_id = ANY(${uuidArray(projects)}) AND a.action = ${MARK_RECORD}
       AND (a.payload ->> 'stamped')::boolean
       AND lower(a.payload ->> 'commit') IN (${among})
  `)) as unknown as Array<{
    project_id: string;
    sha: string;
    at: Date | string;
    target: string | null;
  }>;
}
