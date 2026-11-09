/**
 * What production was read serving before the live build, for the hold read right after a deploy
 * (ISS-1182, FB-592). The served-ancestry pass keeps each whole commit production answers serving
 * (`served_builds`, a record of readings, never the live build: that is read when asked, ISS-1286).
 * After a deploy no pair the pass asked names the new live commit yet, so a verdict commit no release
 * record places has no answer of its own; the build served before it, and what the source host
 * answered that build holds, is the last answer it had, kept until the host says whether the new
 * build descends from that one (`judged-build.ts:liveBuildHolds`).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idOfParts, memoizedPerId, partsOf } from '../db/read-memo.js';
import { servedBuilds } from '../db/schema.js';
import type { ShippedReleaseRun } from './shipped-releases.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** What was served before `live`, as one asked commit reads it. */
export interface ServedBefore {
  /** The commit production was last read serving other than the live one; null where none was read. */
  previous: string | null;
  /** When production was first read serving the live commit; null where the pass has not read it yet. */
  liveSince: Date | null;
  /** Whether the source host answered that the live build descends from `previous`; null unasked. */
  descends: boolean | null;
  /** Whether the source host answered that `previous` holds the asked commit (a kept `descends`). */
  heldByPrevious: boolean;
}

/** Keep that production was read serving each of `commits` now (the served-ancestry pass). */
export async function keepServedBuilds(
  projectId: string,
  commits: readonly string[],
): Promise<void> {
  const whole = [...new Set(commits.map((c) => c.trim().toLowerCase()))].filter((c) =>
    WHOLE.test(c),
  );
  if (whole.length === 0) return;
  await db
    .insert(servedBuilds)
    .values(whole.map((commit) => ({ projectId, commit })))
    .onConflictDoUpdate({
      target: [servedBuilds.projectId, servedBuilds.commit],
      set: { lastReadAt: sql`now()` },
    });
}

/**
 * Per production commit `live`, the pair (the build served before it, `live`) no kept answer names:
 * the one question the served-ancestry pass asks first after a deploy, whose `descends` derives what
 * the live build holds from what the previous build held (ISS-1182).
 */
export async function bridgesOwed(
  projectId: string,
  production: readonly string[],
): Promise<Array<{ judged: string; served: string }>> {
  const owed: Array<{ judged: string; served: string }> = [];
  for (const live of production) {
    const [row] = (await db.execute(sql`
      SELECT prev."commit" AS previous FROM (
        SELECT "commit" FROM served_builds
         WHERE project_id = ${projectId} AND "commit" <> ${live}
         ORDER BY last_read_at DESC LIMIT 1
      ) prev
       WHERE NOT EXISTS (
         SELECT 1 FROM served_ancestry a
          WHERE a.project_id = ${projectId} AND a.judged_commit = prev."commit"
            AND a.served_commit = ${live})
    `)) as unknown as Array<{ previous: string }>;
    if (row) owed.push({ judged: row.previous, served: live });
  }
  return owed;
}

/**
 * Per asked commit, what was served before `live` on the project: the previous build, since when the
 * live one was read, whether it descends from the previous, and whether the previous holds the
 * commit. Every commit asked of one project and live build before the quiet point is one statement
 * (`db/read-memo.ts:memoizedPerId`).
 */
export async function servedBefore(
  projectId: string,
  live: string,
  commits: readonly string[],
): Promise<Map<string, ServedBefore>> {
  const held = await memoizedPerId(
    'servedBefore',
    commits.map((c) => idOfParts(projectId, live, c)),
    beforeOf,
  );
  return new Map([...held].map(([id, v]) => [partsOf(id)[2] as string, v]));
}

async function beforeOf(ids: readonly string[]): Promise<Map<string, ServedBefore>> {
  const asked = ids.map((id) => partsOf(id) as [string, string, string]);
  const groups = [...new Set(asked.map(([p, l]) => idOfParts(p, l)))].map(
    (k) => partsOf(k) as [string, string],
  );
  // every project's live build asked before the quiet point is one statement
  const rows = (await db.execute(sql`
    WITH asks AS (
      SELECT * FROM unnest(${sql.param(groups.map((g) => g[0]))}::uuid[],
                           ${sql.param(groups.map((g) => g[1]))}::text[]) AS a(project_id, live)
    ), prev AS (
      SELECT DISTINCT ON (a.project_id, a.live) a.project_id, a.live, b."commit"
        FROM asks a JOIN served_builds b ON b.project_id = a.project_id AND b."commit" <> a.live
       ORDER BY a.project_id, a.live, b.last_read_at DESC
    )
    SELECT a.project_id::text AS project_id, a.live, p."commit" AS previous,
           (SELECT s.first_read_at FROM served_builds s
             WHERE s.project_id = a.project_id AND s."commit" = a.live) AS live_since,
           (SELECT x.carried FROM served_ancestry x
             WHERE x.project_id = a.project_id AND x.judged_commit = p."commit"
               AND x.served_commit = a.live) AS descends,
           coalesce((SELECT array_agg(x.judged_commit) FROM served_ancestry x
                      WHERE x.project_id = a.project_id AND x.served_commit = p."commit" AND x.carried
                        AND x.judged_commit = ANY(${sql.param([...new Set(asked.map((a) => a[2]))])}::text[])),
                    '{}') AS held
      FROM asks a LEFT JOIN prev p ON p.project_id = a.project_id AND p.live = a.live
  `)) as unknown as Array<{
    project_id: string;
    live: string;
    previous: string | null;
    live_since: Date | string | null;
    descends: boolean | null;
    held: string[];
  }>;
  const byGroup = new Map(rows.map((r) => [idOfParts(r.project_id, r.live), r]));
  const out = new Map<string, ServedBefore>();
  for (const [projectId, live, commit] of asked) {
    const row = byGroup.get(idOfParts(projectId, live));
    out.set(idOfParts(projectId, live, commit), {
      previous: row?.previous ?? null,
      liveSince: row?.live_since == null ? null : new Date(row.live_since),
      descends: row?.descends ?? null,
      heldByPrevious: row?.held.includes(commit) ?? false,
    });
  }
  return out;
}

/** What the build served before answers of a commit (`heldBefore`). */
export type KeptBefore = true | string | { rechecking: string };

/** How long a deploy keeps the previous build's answers while the pass asks the new one's. */
export const RECHECK_FOR_MS = 10 * 60_000;

/**
 * Per commit no answer about the live build places, what the build served before it answers (ISS-1182,
 * FB-592): every push deploys on forge-dev, and until the served-ancestry pass asks the pairs naming
 * the new live commit, a verdict the previous build held read as not judged. Where the previous build
 * held it (it is that build, a release cut no later, or the source host answered it holds it): `true`
 * where the host answered the live build descends from the previous one; where that is not asked yet,
 * the previous build's answer marked as re-checked, for {@link RECHECK_FOR_MS} after the pass first
 * read the live build at most; a sentence why it is not kept past that; absent where the previous
 * build did not hold it, the live build does not descend from it, or no previous build was read.
 */
export async function heldBefore(
  projectId: string,
  live: string,
  commits: readonly string[],
  releases: readonly ShippedReleaseRun[],
  read: typeof servedBefore = servedBefore,
): Promise<Map<string, KeptBefore>> {
  const out = new Map<string, KeptBefore>();
  if (commits.length === 0) return out;
  const asked = await read(projectId, live, commits);
  for (const commit of commits) {
    const b = asked.get(commit);
    const previous = b?.previous;
    if (!b || !previous || b.descends === false) continue;
    const prevRun = releases.find((r) => r.commit === previous);
    const run = releases.find((r) => r.commit === commit);
    const heldThere =
      (commit.length >= 7 && previous.startsWith(commit)) ||
      b.heldByPrevious ||
      (run !== undefined && prevRun !== undefined && run.cutAt <= prevRun.cutAt);
    if (!heldThere) continue;
    if (b.descends === true) {
      out.set(commit, true);
      continue;
    }
    if (b.liveSince && Date.now() - b.liveSince.getTime() > RECHECK_FOR_MS) {
      out.set(
        commit,
        `the build served before, \`${previous}\`, held it, and its answer was kept as re-checked for ${RECHECK_FOR_MS / 60_000} minutes; the source host has not answered whether the live build \`${live}\` descends from it`,
      );
      continue;
    }
    out.set(commit, {
      rechecking: `the build served before, \`${previous}\`, holds it; whether the live build \`${live}\`, deployed since, descends from it is being re-checked`,
    });
  }
  return out;
}
