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
  const asks = new Map<string, string[]>();
  for (const id of ids) {
    const [projectId = '', live = '', commit = ''] = partsOf(id);
    const key = idOfParts(projectId, live);
    asks.set(key, [...(asks.get(key) ?? []), commit]);
  }
  const out = new Map<string, ServedBefore>();
  await Promise.all(
    [...asks].map(async ([key, commits]) => {
      const [projectId = '', live = ''] = partsOf(key);
      const [row] = (await db.execute(sql`
        WITH prev AS (
          SELECT "commit" FROM served_builds
           WHERE project_id = ${projectId} AND "commit" <> ${live}
           ORDER BY last_read_at DESC LIMIT 1
        )
        SELECT (SELECT "commit" FROM prev) AS previous,
               (SELECT first_read_at FROM served_builds
                 WHERE project_id = ${projectId} AND "commit" = ${live}) AS live_since,
               (SELECT a.carried FROM served_ancestry a JOIN prev ON a.judged_commit = prev."commit"
                 WHERE a.project_id = ${projectId} AND a.served_commit = ${live}) AS descends,
               coalesce((SELECT array_agg(a.judged_commit) FROM served_ancestry a
                           JOIN prev ON a.served_commit = prev."commit"
                          WHERE a.project_id = ${projectId} AND a.carried
                            AND a.judged_commit = ANY(${sql.param(commits)}::text[])),
                        '{}') AS held
      `)) as unknown as Array<{
        previous: string | null;
        live_since: Date | string | null;
        descends: boolean | null;
        held: string[];
      }>;
      const heldBy = new Set(row?.held ?? []);
      for (const commit of commits) {
        out.set(idOfParts(projectId, live, commit), {
          previous: row?.previous ?? null,
          liveSince: row?.live_since == null ? null : new Date(row.live_since),
          descends: row?.descends ?? null,
          heldByPrevious: heldBy.has(commit),
        });
      }
    }),
  );
  return out;
}

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
): Promise<Map<string, true | string | { rechecking: string }>> {
  const out = new Map<string, true | string | { rechecking: string }>();
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
