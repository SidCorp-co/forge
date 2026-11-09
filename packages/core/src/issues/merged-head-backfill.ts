// ISS-1168: a merge mark on a change-request project stamped the host's merge of a request with no
// head before the mark read one (`host-mark.ts:withRequestHead`), so no verdict judged at that
// request's head counted for the landing (REQ-63 BC-6). This pass gives each such stamp its head
// once, from the projection's `head_sha`, its tree read against the landing from the host.

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { sql } from 'drizzle-orm';
import { backfillMarkedIn, markBackfillIn } from '../db/backfill-markers.js';
import { type Db, db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { releasesThroughChangeRequestsSql } from './host-landing.js';
import { requestHeadOf } from './request-head-port.js';

/** The `backfill_markers` key set once every standing mark has been given its request's head. */
export const MARKED_REQUEST_HEAD_KEY = 'marked-request-head';

interface Standing {
  id: string;
  project_id: string;
  commit: string;
  heads: string[];
  linked_heads: string[];
}

interface FilledHead {
  issueId: string;
  commit: string;
  head: MergedHead | null;
}

export interface MarkedHeadReport {
  /** Per project: each stamp given its head, and each left as it was because its head is ambiguous. */
  projects: Array<{
    projectId: string;
    filled: FilledHead[];
    ambiguous: Array<{ issueId: string; commit: string; why: string }>;
  }>;
}

type Executor = Pick<Db, 'execute' | 'transaction'>;

/**
 * Every issue on a project releasing through change requests whose stamp is the host's merge of a
 * request into the stamped branch and holds no head. Where several merged requests carry that merge
 * commit (GitLab marks a stale request merged at another's commit), a request linking the issue
 * names the head; heads that still disagree are left as they are, named, never picked.
 */
async function standingMarks(conn: Executor): Promise<Standing[]> {
  return (await conn.execute(sql`
    SELECT i.id, i.project_id, lower(i.merged_commit_sha) AS commit,
           array_agg(DISTINCT lower(p.head_sha)) AS heads,
           coalesce(array_agg(DISTINCT lower(p.head_sha)) FILTER (WHERE l.issue_id IS NOT NULL),
                    '{}') AS linked_heads
      FROM issues i
      JOIN repo_pull_requests p
        ON p.project_id = i.project_id AND p.state = 'merged'
       AND lower(p.merge_commit_sha) = lower(i.merged_commit_sha)
       AND (i.merged_target IS NULL OR p.base_ref = i.merged_target)
      LEFT JOIN repo_pull_request_issues l ON l.pull_request_id = p.id AND l.issue_id = i.id
     WHERE i.merged_head IS NULL AND i.merged_commit_sha IS NOT NULL
       AND ${releasesThroughChangeRequestsSql(sql`i`)}
     GROUP BY i.id, i.project_id, i.merged_commit_sha
     ORDER BY i.project_id, i.iss_seq
  `)) as unknown as Standing[];
}

/** The one head the requests merged at the stamp carry, or why there is no one. */
function oneHead(row: Standing): { sha: string } | { why: string } {
  const heads = row.linked_heads.length > 0 ? row.linked_heads : row.heads;
  const [sha] = heads;
  if (heads.length === 1 && sha) return { sha };
  return {
    why: `the requests merged as ${row.commit.slice(0, 12)} carry ${heads.length} heads (${heads.map((h) => h.slice(0, 12)).join(', ')}), so which one landed is not read from the projection; mark the issue again to read it from the host`,
  };
}

/**
 * Give each standing mark its request's head once (ISS-1168), as the mark now records it: the
 * projection's head, its tree read against the landing from the host, and a read that fails kept
 * unread with why, never guessed. It writes `merged_head` on a row still holding none at the same
 * commit and nothing else: no status, commit, time or target moves. Logged per project; the marker
 * keeps the whole report. Returns null when it already ran.
 */
export async function runMarkedRequestHeadBackfillOnce(
  conn: Executor = db,
): Promise<MarkedHeadReport | null> {
  if (await conn.transaction((tx) => backfillMarkedIn(tx, MARKED_REQUEST_HEAD_KEY))) return null;
  const byProject = new Map<string, MarkedHeadReport['projects'][number]>();
  for (const row of await standingMarks(conn)) {
    let project = byProject.get(row.project_id);
    if (!project) {
      project = { projectId: row.project_id, filled: [], ambiguous: [] };
      byProject.set(row.project_id, project);
    }
    const one = oneHead(row);
    if ('why' in one) {
      project.ambiguous.push({ issueId: row.id, commit: row.commit, why: one.why });
      continue;
    }
    const head = await requestHeadOf(row.project_id, one.sha, row.commit);
    const wrote = (await conn.execute(sql`
      UPDATE issues SET merged_head = ${JSON.stringify(head)}::jsonb
       WHERE id = ${row.id} AND merged_head IS NULL AND lower(merged_commit_sha) = ${row.commit}
      RETURNING id
    `)) as unknown as unknown[];
    if (wrote.length > 0) project.filled.push({ issueId: row.id, commit: row.commit, head });
  }
  const report: MarkedHeadReport = { projects: [...byProject.values()] };
  for (const p of report.projects) {
    const read = (t: boolean | null) => p.filled.filter((f) => f.head?.treeIdentical === t).length;
    logger.info(
      {
        projectId: p.projectId,
        filled: p.filled.length,
        identical: read(true),
        different: read(false),
        unread: read(null),
        ambiguous: p.ambiguous.map((a) => a.issueId),
      },
      'boot: standing merge marks given their request head (ISS-1168)',
    );
  }
  await conn.transaction((tx) => markBackfillIn(tx, MARKED_REQUEST_HEAD_KEY, report));
  return report;
}
