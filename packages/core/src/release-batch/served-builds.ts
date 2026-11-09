/**
 * What production was read serving before the live build, for the hold read right after a deploy
 * (ISS-1182, FB-592). Each whole commit production answers serving is kept (`served_builds`, a record
 * of readings, never the live build: that is read when asked, ISS-1286): by the live read where it
 * first reads it (`keepLiveBuild`), and by the served-ancestry pass. After a deploy no pair the pass
 * asked names the new live commit yet, so a verdict commit no release record places has no answer of
 * its own; the builds served before it, and what the source host answered they hold, are the last
 * answer it had, kept until the host says whether the new build descends from them
 * (`judged-build.ts:liveBuildHolds`).
 *
 * The last {@link BUILDS_BACK} builds are weighed, not only the one before: on forge-dev a landing and
 * its release commit deploy minutes apart, and a build served between two passes held what the one
 * before it held without any row naming it (ISS-1182 round 2: 826231cc63 never read by a pass, then
 * 3cd21bcdc7's holds derived from b2cdb0d53c's, both read cold on the next deploy).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idOfParts, memoizedPerId, partsOf } from '../db/read-memo.js';
import { servedAncestry, servedBuilds } from '../db/schema.js';
import { background } from '../lib/background.js';
import { logger } from '../lib/logger.js';
import type { ShippedReleaseRun } from './shipped-releases.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** How many builds production was read serving before the live one a read weighs, newest first. */
export const BUILDS_BACK = 3;

/** One build production was read serving before the live one, as one asked commit reads it. */
export interface BuildBefore {
  commit: string;
  /** Whether the live build descends from it: answered for the pair, or through a newer build kept
   *  between them; null where neither is answered. */
  descends: boolean | null;
  /** Whether the source host answered that this build holds the asked commit (a kept row). */
  holds: boolean;
}

/** What was served before `live`, as one asked commit reads it. */
export interface ServedBefore {
  /** When production was first read serving the live commit; null where it was not read yet. */
  liveSince: Date | null;
  /** The builds production was read serving before the live one, newest first. */
  before: BuildBefore[];
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

// The live build last kept per project by this process: a read keeps a build once, where it first
// reads it, never once a read.
const LIVE_KEPT = new Map<string, string>();
const liveKeeps = background();

/**
 * Keep that production was read serving `sha`, the first time this process reads it serving it: one
 * upsert per project per new live build, started beside the read and never waited on, outside its
 * timing (`lib/background.ts`). A build served between two passes is kept all the same (ISS-1182
 * round 2: the pass first ran two minutes after a container started serving).
 */
export function keepLiveBuild(projectId: string, sha: string): void {
  const live = sha.trim().toLowerCase();
  if (!WHOLE.test(live) || LIVE_KEPT.get(projectId) === live) return;
  LIVE_KEPT.set(projectId, live);
  liveKeeps.start(
    () => keepServedBuilds(projectId, [live]),
    (err) => {
      if (LIVE_KEPT.get(projectId) === live) LIVE_KEPT.delete(projectId);
      logger.warn(
        { projectId, live, err: err instanceof Error ? err.message : String(err) },
        'served build not kept: the next read keeps it',
      );
    },
  );
}

/** A kept answer between two commits of a window: `judged>served`. */
const linkKey = (judged: string, served: string) => `${judged}>${served}`;

/**
 * Whether `live` descends from each build of `window` (newest first): the pair's own answer, else
 * through a newer build of the window it is answered `live` descends from and that descends from it.
 */
function descentOf(
  window: readonly string[],
  links: ReadonlyMap<string, boolean>,
  live: string,
): Map<string, boolean | null> {
  const out = new Map<string, boolean | null>();
  for (const [i, build] of window.entries()) {
    const own = links.get(linkKey(build, live));
    const through = window
      .slice(0, i)
      .some((newer) => links.get(linkKey(build, newer)) === true && out.get(newer) === true);
    out.set(build, own ?? (through ? true : null));
  }
  return out;
}

/** The window of builds kept before `live` and every answer between them, one statement. */
async function windowOf(
  projectId: string,
  live: string,
): Promise<{ window: string[]; links: Map<string, boolean> }> {
  const rows = (await db.execute(sql`
    WITH win AS (
      SELECT "commit", last_read_at AS at FROM served_builds
       WHERE project_id = ${projectId} AND "commit" <> ${live}
       ORDER BY last_read_at DESC, "commit" LIMIT ${BUILDS_BACK}
    )
    SELECT w."commit" AS build, x.served_commit AS served, x.carried
      FROM win w LEFT JOIN served_ancestry x
        ON x.project_id = ${projectId} AND x.judged_commit = w."commit"
       AND (x.served_commit = ${live} OR x.served_commit IN (SELECT "commit" FROM win))
     ORDER BY w.at DESC, w."commit"
  `)) as unknown as Array<{ build: string; served: string | null; carried: boolean | null }>;
  return windowRows(rows);
}

function windowRows(
  rows: ReadonlyArray<{ build: string; served: string | null; carried: boolean | null }>,
): { window: string[]; links: Map<string, boolean> } {
  const links = new Map<string, boolean>();
  for (const r of rows) {
    if (r.served !== null && r.carried !== null) links.set(linkKey(r.build, r.served), r.carried);
  }
  return { window: [...new Set(rows.map((r) => r.build))], links };
}

/**
 * Per production commit `live`, the pairs (a build kept before it, `live`) the source host is asked
 * first after a deploy, newest build first: each whose answer is not kept and does not follow from a
 * newer build's. Their `descends` derives what the live build holds from what those builds held
 * (ISS-1182): one pair a deploy where every build was read by a pass, one a build served between two.
 */
export async function bridgesOwed(
  projectId: string,
  production: readonly string[],
): Promise<Array<{ judged: string; served: string }>> {
  const owed: Array<{ judged: string; served: string }> = [];
  for (const live of production) {
    const { window, links } = await windowOf(projectId, live);
    const descent = descentOf(window, links, live);
    for (const [i, build] of window.entries()) {
      if (links.has(linkKey(build, live))) continue;
      const follows = window
        .slice(0, i)
        .some((newer) => links.get(linkKey(build, newer)) === true && descent.get(newer) !== false);
      if (!follows) owed.push({ judged: build, served: live });
    }
  }
  return owed;
}

/**
 * Keep that each `live` build holds each commit the builds before it held, once the host answered it
 * descends from them (`heldBefore` true): ancestry is transitive and never changes, so the next deploy
 * reads it from the row and no window has to reach back to the build the host first answered for.
 * One statement, only where some pair is new.
 */
export async function keepDerived(
  projectId: string,
  pairs: ReadonlyArray<{ judged: string; served: string }>,
): Promise<number> {
  const whole = pairs.filter(
    (p) => p.judged !== p.served && WHOLE.test(p.judged) && WHOLE.test(p.served),
  );
  if (whole.length === 0) return 0;
  const written = await db
    .insert(servedAncestry)
    .values(
      whole.map((p) => ({
        projectId,
        servedCommit: p.served,
        judgedCommit: p.judged,
        carried: true,
        differsIn: null,
      })),
    )
    .onConflictDoNothing()
    .returning({ projectId: servedAncestry.projectId });
  return written.length;
}

/**
 * Per asked commit, what was served before `live` on the project: since when the live one was read,
 * and each build kept before it with whether the live build descends from it and whether it holds the
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
    ), win AS (
      SELECT a.project_id, a.live, b."commit", b.at
        FROM asks a CROSS JOIN LATERAL (
          SELECT s."commit", s.last_read_at AS at FROM served_builds s
           WHERE s.project_id = a.project_id AND s."commit" <> a.live
           ORDER BY s.last_read_at DESC, s."commit" LIMIT ${BUILDS_BACK}) b
    )
    SELECT a.project_id::text AS project_id, a.live,
           (SELECT s.first_read_at FROM served_builds s
             WHERE s.project_id = a.project_id AND s."commit" = a.live) AS live_since,
           coalesce((SELECT json_agg(json_build_object(
               'build', w."commit",
               'links', coalesce((SELECT json_agg(json_build_object('served', x.served_commit,
                                                                    'carried', x.carried))
                                    FROM served_ancestry x
                                   WHERE x.project_id = a.project_id AND x.judged_commit = w."commit"
                                     AND (x.served_commit = a.live OR x.served_commit IN (
                                       SELECT v."commit" FROM win v
                                        WHERE v.project_id = a.project_id AND v.live = a.live))),
                                 '[]'::json),
               'held', coalesce((SELECT json_agg(x.judged_commit) FROM served_ancestry x
                                  WHERE x.project_id = a.project_id AND x.served_commit = w."commit"
                                    AND x.carried
                                    AND x.judged_commit = ANY(${sql.param([...new Set(asked.map((a) => a[2]))])}::text[])),
                                '[]'::json))
             ORDER BY w.at DESC, w."commit")
              FROM win w WHERE w.project_id = a.project_id AND w.live = a.live), '[]'::json) AS before
      FROM asks a
  `)) as unknown as Array<{
    project_id: string;
    live: string;
    live_since: Date | string | null;
    before: Array<{
      build: string;
      links: Array<{ served: string; carried: boolean }>;
      held: string[];
    }>;
  }>;
  const byGroup = new Map(
    rows.map((r) => {
      const { window, links } = windowRows(
        r.before.flatMap((b) => [
          { build: b.build, served: null, carried: null },
          ...b.links.map((l) => ({ build: b.build, served: l.served, carried: l.carried })),
        ]),
      );
      const descent = descentOf(window, links, r.live);
      return [
        idOfParts(r.project_id, r.live),
        {
          liveSince: r.live_since == null ? null : new Date(r.live_since),
          builds: r.before.map((b) => ({
            commit: b.build,
            descends: descent.get(b.build) ?? null,
            held: new Set(b.held),
          })),
        },
      ] as const;
    }),
  );
  const out = new Map<string, ServedBefore>();
  for (const [projectId, live, commit] of asked) {
    const group = byGroup.get(idOfParts(projectId, live));
    out.set(idOfParts(projectId, live, commit), {
      liveSince: group?.liveSince ?? null,
      before: (group?.builds ?? []).map((b) => ({
        commit: b.commit,
        descends: b.descends,
        holds: b.held.has(commit),
      })),
    });
  }
  return out;
}

/** What the builds served before answer of a commit (`heldBefore`). */
export type KeptBefore = true | string | { rechecking: string };

/** How long a deploy keeps the builds before's answers while the pass asks the new one's. */
export const RECHECK_FOR_MS = 10 * 60_000;

/**
 * Per commit no answer about the live build places, what the builds served before it answer
 * (ISS-1182, FB-592): every push deploys on forge-dev, and until the served-ancestry pass asks the
 * pairs naming the new live commit, a verdict an earlier build held read as not judged. Where a build
 * kept before it held the commit (it is that build, a release cut no later, or the source host
 * answered it holds it) and the live build is not answered as not descending from it: `true` where the
 * live build is answered to descend from it; where that is not asked yet, its answer marked as
 * re-checked, for {@link RECHECK_FOR_MS} after the live build was first read at most; a sentence why
 * it is not kept past that; absent where no such build held it.
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
    if (!b) continue;
    const run = releases.find((r) => r.commit === commit);
    const holders = b.before.filter((build) => {
      if (build.descends === false) return false;
      const buildRun = releases.find((r) => r.commit === build.commit);
      return (
        (commit.length >= 7 && build.commit.startsWith(commit)) ||
        build.holds ||
        (run !== undefined && buildRun !== undefined && run.cutAt <= buildRun.cutAt)
      );
    });
    const holder = holders[0];
    if (!holder) continue;
    if (holders.some((h) => h.descends === true)) {
      out.set(commit, true);
      continue;
    }
    if (b.liveSince && Date.now() - b.liveSince.getTime() > RECHECK_FOR_MS) {
      out.set(
        commit,
        `the build served before, \`${holder.commit}\`, held it, and its answer was kept as re-checked for ${RECHECK_FOR_MS / 60_000} minutes; the source host has not answered whether the live build \`${live}\` descends from it`,
      );
      continue;
    }
    out.set(commit, {
      rechecking: `the build served before, \`${holder.commit}\`, holds it; whether the live build \`${live}\`, deployed since, descends from it is being re-checked`,
    });
  }
  return out;
}
