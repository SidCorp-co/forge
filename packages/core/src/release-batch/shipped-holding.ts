/**
 * Whether a commit a verdict names, where it is the commit a shipped release of the project recorded
 * shipping, holds the issue's landing (ISS-1079, FB-545), read from Forge's own rows and never from
 * the host:
 *
 * - it does where the release holding the issue (`issues/release-evidence.ts:holdingReleaseRunsSql`)
 *   shipped at it, since that release was cut and shipped carrying the issue's work (round 2:
 *   sidcorp-mail's 0.16.0 shipped ISS-11 at 62a4ac7, a merge into `master` no landing mark names);
 * - and where a later release shipped at it, it does as far as the kept ancestry says
 *   (`served_ancestry`, `served-ancestry.ts`): that commit holds the issue's landing, or the commit
 *   the release holding the issue shipped (round 3: ISS-7 landed at 3908750d and shipped in 0.9.0,
 *   judged at 62a4ac7, which 0.16.0 shipped carrying ISS-11 alone). A pair nothing kept is unread,
 *   with the act that keeps it; it is never inferred from version order, since a hotfix cut from an
 *   older tag holds nothing landed after it.
 *
 * A commit no shipped release recorded is not answered here (`recorded-holding.ts` answers it).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { idOfParts, memoizedPerId, partsOf } from '../db/read-memo.js';
import { holdingReleaseRunsSql } from '../issues/index.js';
import type { Holding } from './landed-build.js';

/** One issue, its landing, and a whole commit one of its verdicts names. */
export interface ShippedAsk {
  issueId: string;
  landing: string;
  sha: string;
}

export const shippedAskKey = (a: Pick<ShippedAsk, 'issueId' | 'sha'>) =>
  `${a.issueId.toLowerCase()}:${a.sha.toLowerCase()}`;

const short = (sha: string) => sha.slice(0, 12);

interface Row {
  issue_id: string;
  sha: string;
  landing: string;
  /** The release holding the issue that shipped at `sha`, where one did. */
  holder: string | null;
  /** Every shipped release of the project that recorded shipping at `sha`. */
  shipped_by: string | null;
  /** What the kept ancestry says of `sha` holding the landing; null where nothing is kept. */
  holds_landing: boolean | null;
  /** Whether the kept ancestry says `sha` holds the commit a release holding the issue shipped. */
  holds_release: boolean;
}

/**
 * Per ask (`shippedAskKey`) whose commit a shipped release of the project recorded shipping, whether
 * it holds the issue's landing, or why that is unread. Asks at any other commit are left out. An
 * ask's answer is its project's own, so every project's asks before the quiet point are one read
 * (`db/read-memo.ts:memoizedPerId`, ISS-1070 r10).
 */
export async function shippedCommitHolding(
  projectId: string,
  asks: readonly ShippedAsk[],
): Promise<Map<string, Holding>> {
  const out = new Map<string, Holding>();
  if (asks.length === 0) return out;
  const held = await memoizedPerId(
    'shippedHolding',
    asks.map((a) =>
      idOfParts(projectId, a.issueId.toLowerCase(), a.landing.toLowerCase(), a.sha.toLowerCase()),
    ),
    holdingsOf,
  );
  for (const [key, holding] of held) {
    const [, issueId = '', , sha = ''] = partsOf(key);
    out.set(shippedAskKey({ issueId, sha }), holding);
  }
  return out;
}

/** Each asked project, issue, landing and commit's (`idOfParts`) holding, where a shipped release recorded the commit. */
async function holdingsOf(keys: readonly string[]): Promise<Map<string, Holding>> {
  const values = sql.join(
    keys.map((k) => {
      const [project, issueId, landing, sha] = partsOf(k);
      return sql`(${project}::uuid, ${issueId}, ${landing}, ${sha})`;
    }),
    sql`, `,
  );
  const projects = [...new Set(keys.map((k) => partsOf(k)[0] as string))];
  const holding = sql`(${holdingReleaseRunsSql(sql`a.issue_id`, sql`a.project_id`)})`;
  const rows = (await db.execute(sql`
    WITH shipped AS (
      SELECT r.id, r.project_id, r.release_version AS version, r.release_released_at AS at,
             lower(r.metadata -> 'finish' ->> 'commit') AS commit
        FROM pipeline_runs r
       WHERE r.project_id = ANY(${uuidArray(projects)})
         AND r.metadata ->> 'source' = 'release-batch'
         AND r.metadata -> 'finish' ->> 'state' = 'finished'
         AND r.release_version IS NOT NULL AND r.release_released_at IS NOT NULL)
    SELECT a.project_id::text AS project_id, a.issue_id, a.sha, a.landing,
           (SELECT b.version FROM shipped b
             WHERE b.project_id = a.project_id AND b.commit = a.sha
               AND EXISTS (SELECT 1 FROM ${holding} h WHERE h.id = b.id)
             LIMIT 1) AS holder,
           (SELECT string_agg(b.version, ', ' ORDER BY b.at, b.id) FROM shipped b
             WHERE b.project_id = a.project_id AND b.commit = a.sha) AS shipped_by,
           (SELECT s.carried FROM served_ancestry s
             WHERE s.project_id = a.project_id AND s.served_commit = a.sha
               AND s.judged_commit = a.landing) AS holds_landing,
           EXISTS (SELECT 1 FROM ${holding} h
                     JOIN pipeline_runs hr ON hr.id = h.id
                     JOIN served_ancestry s ON s.project_id = a.project_id AND s.served_commit = a.sha
                      AND s.judged_commit = lower(hr.metadata -> 'finish' ->> 'commit') AND s.carried
           ) AS holds_release
      FROM (VALUES ${values}) AS a(project_id, issue_id, landing, sha)
  `)) as unknown as (Row & { project_id: string })[];
  const out = new Map<string, Holding>();
  for (const r of rows) {
    if (r.shipped_by === null) continue;
    out.set(idOfParts(r.project_id, r.issue_id, r.landing, r.sha), holdingOf(r, r.shipped_by));
  }
  return out;
}

function holdingOf(r: Row, shippedBy: string): Holding {
  if (r.holder !== null || r.holds_landing === true || r.holds_release) return true;
  if (r.holds_landing === false) return false;
  return {
    unread: `\`${short(r.sha)}\` is the commit release ${shippedBy} shipped, and no ancestry Forge kept says whether it holds the landing \`${short(r.landing)}\`: the pipeline sweep asks the source host once and keeps the answer (\`served_ancestry\`), and a read never asks`,
  };
}
