/**
 * The merges a source host reported that no Forge record carries yet, as what an agent owes (ISS-774,
 * owner ruling 2026-10-29: Forge tells the agent and the agent records the merge; no hook or trigger
 * writes it). The host's report is read from
 * the projection only; nothing here calls the host, and nothing here writes.
 *
 * Two shapes:
 * - an issue a merged change request delivers (its link) that holds no merged mark owes "mark merged
 *   !N at <sha>" to whoever works it: its run where one holds it, else the project's master;
 * - where the project's gate `issue_before_code` is off (REQ-76 BC-8), a merge into its default branch
 *   that delivers no issue owes the master "file the issue for merge !N at <sha>"; the filing is
 *   answered by an issue whose mark names that commit, which the mark takes as that issue's landing
 *   for the reason it is owed (`owedFilingOfMark`): the commit names no issue to judge it by.
 */

import { eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { TransitionActor } from './actor-agency.js';
import { issueGateOf } from './gates.js';
import { targetBranchSql } from './host-landing.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { MARK_RECORD, UNMARK_RECORD } from './mark-trail.js';
import { readLandingBranches, settleChangeRequestRelease } from './ports.js';

/** The merged change request an issue's mark is owed for. */
export interface OwedMark {
  number: number;
  commit: string;
  target: string;
  url: string | null;
}

/**
 * The newest change request linked to the issue row `i` that the host reports merged into its project's
 * target branch, as `{number, commit, target, url}`, where `i` holds no merged mark and is not finished;
 * else null. A request merged before the issue's last unmark is a landing somebody withdrew, not owed.
 */
export const owedMarkSql = (i: SQL): SQL => sql`(CASE WHEN ${i}.merged_at IS NULL
  AND ${i}.status NOT IN ('closed', 'dropped', 'draft') THEN (
  SELECT jsonb_build_object('number', op.number, 'commit', op.merge_commit_sha, 'target', op.base_ref,
                            'url', op.html_url)
    FROM repo_pull_request_issues ol
    JOIN repo_pull_requests op ON op.id = ol.pull_request_id
   WHERE ol.issue_id = ${i}.id AND op.state = 'merged' AND op.merge_commit_sha IS NOT NULL
     AND op.base_ref = ${targetBranchSql(i)}
     AND op.merged_at > coalesce((SELECT max(ua.created_at) FROM activity_log ua
                                   WHERE ua.issue_id = ${i}.id AND ua.action = ${UNMARK_RECORD}),
                                 '-infinity'::timestamptz)
   ORDER BY op.merged_at DESC LIMIT 1) END)`;

/** One merge the master is owed a filing for: a merge into the default branch delivering no issue. */
export interface OwedFiling {
  number: number;
  commit: string;
  title: string;
  url: string | null;
  mergedAt: string;
}

/** One issue owing its mark, as the master reads it. */
export interface OwedMarkRow extends OwedMark {
  issueId: string;
  key: string;
}

/**
 * How far back a merge naming no issue is asked for. Before ISS-774 a host's report filed it as it
 * arrived (the removed `host-merge.ts`), so an older one left unfiled is one that consumer refused or
 * a merge from before the profile let code come first; asking for every such merge in a repository's
 * history would bury the master's pass under work nobody owes. Priced: a merge older than this that
 * nothing filed stays unrecorded; it ends when a filing door reads the profile's own switch-over time.
 * The window bounds the ASK only: a mark answering a filing (`owedFilingOfMark`) reads no window, so a
 * filing in flight when its merge ages out is still taken rather than refused as nobody's.
 */
export const OWED_FILING_DAYS = 14;

type FilingRow = {
  number: number;
  commit: string;
  title: string;
  url: string | null;
  merged_at: Date | string;
};

/**
 * The project's merges into its default branch owed a filing: no promotion, no change request link,
 * and no issue of the project answering it, by its observed commit, the filing Forge once wrote, or
 * a current stamped mark claiming it. A mark an unmark withdrew answers nothing, so its merge is
 * owed again, and one the first stamp outranked never answered it. `scope` narrows it to the window
 * the master is asked about, or to one commit judged for the issue `except` names, whose own answer
 * is the mark it is making again.
 */
async function owedFilingRows(
  projectId: string,
  scope: { days: number } | { commit: string; except: string },
): Promise<FilingRow[]> {
  if ((await issueGateOf(projectId, 'issue_before_code')).mode === 'enforce') return [];
  const { defaultBranch, promotes } = await readLandingBranches(projectId);
  if (!defaultBranch) return [];
  const except = 'except' in scope ? sql`AND fi.id <> ${scope.except}::uuid` : sql``;
  const exceptMark = 'except' in scope ? sql`AND fai.id <> ${scope.except}::uuid` : sql``;
  return (await db.execute(sql`
    SELECT p.number, lower(p.merge_commit_sha) AS commit, p.title, p.html_url AS url, p.merged_at
      FROM repo_pull_requests p
     WHERE p.project_id = ${projectId}::uuid AND p.state = 'merged' AND p.base_ref = ${defaultBranch}
       AND p.merge_commit_sha IS NOT NULL
       ${
         'days' in scope
           ? sql`AND p.merged_at > now() - make_interval(days => ${scope.days})`
           : sql`AND lower(p.merge_commit_sha) = lower(${scope.commit})`
       }
       ${
         promotes.length > 0
           ? sql`AND p.head_ref NOT IN (${sql.join(
               promotes.map((b) => sql`${b}`),
               sql`, `,
             )})`
           : sql``
       }
       AND NOT EXISTS (SELECT 1 FROM repo_pull_request_issues l WHERE l.pull_request_id = p.id)
       AND NOT EXISTS (
         SELECT 1 FROM issues fi
          WHERE fi.project_id = p.project_id ${except}
            AND (lower(fi.merged_commit_sha) = lower(p.merge_commit_sha)
                 OR fi.detector_key = 'merged/' || lower(p.merge_commit_sha)))
       AND NOT EXISTS (
         SELECT 1 FROM activity_log fa JOIN issues fai ON fai.id = fa.issue_id
          WHERE fai.project_id = p.project_id ${exceptMark} AND fa.action = ${MARK_RECORD}
            AND (fa.payload ->> 'stamped')::boolean
            AND lower(fa.payload ->> 'commit') = lower(p.merge_commit_sha)
            AND NOT EXISTS (SELECT 1 FROM activity_log ua
                             WHERE ua.issue_id = fa.issue_id AND ua.action = ${UNMARK_RECORD}
                               AND ua.created_at >= fa.created_at))
     ORDER BY p.merged_at, p.number
  `)) as unknown as FilingRow[];
}

const filingOf = (r: FilingRow): OwedFiling => ({
  number: Number(r.number),
  commit: r.commit,
  title: r.title,
  url: r.url,
  mergedAt: new Date(r.merged_at).toISOString(),
});

/** Every merge the master owes a filing for (REQ-76 BC-8, as owed rather than written by Forge). */
export async function owedFilings(projectId: string): Promise<OwedFiling[]> {
  return (await owedFilingRows(projectId, { days: OWED_FILING_DAYS })).map(filingOf);
}

/**
 * The owed filing a mark of `issueId` at `commit` answers, or null: the merge at `commit` is one the
 * issue's own project owes a filing for, and the commit declares no issue (`declared`, the keys its
 * subject names by `declaredIssueSeqs`). A filing is the issue filed for a merge that names none, so
 * its mark cannot be judged by the subject the merge never had; a commit declaring an issue is that
 * issue's, and a merge another issue of the project already answers is that issue's. The ask's window
 * is not read here (`OWED_FILING_DAYS`).
 */
export async function owedFilingOfMark(args: {
  projectId: string;
  issueId: string;
  commit: string;
  declared: readonly number[];
}): Promise<OwedFiling | null> {
  if (args.declared.length > 0) return null;
  const [row] = await owedFilingRows(args.projectId, {
    commit: args.commit,
    except: args.issueId,
  });
  return row ? filingOf(row) : null;
}

/**
 * The owed filing `issueId` answers, or null: its observed landing (`merged_commit_sha`) is a merge
 * its project owed a filing for, which no other issue answers. Such an issue was filed for code that
 * landed before it, so it closes on the release that already shipped that merge, from where it
 * stands (`release-batch/shipped-in.ts:recordShippedIn`, the `filing_released` edge). A mark that
 * is only a caller's claim records no commit here, and answers no filing this reads.
 */
export async function filingAnsweredBy(issueId: string): Promise<OwedFiling | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, commit: issues.mergedCommitSha })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row?.commit) return null;
  const [filing] = await owedFilingRows(row.projectId, { commit: row.commit, except: issueId });
  return filing ? filingOf(filing) : null;
}

/** Every issue of the project owing its mark for a merged change request, as the master reads them. */
export async function owedMarks(projectId: string): Promise<OwedMarkRow[]> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.iss_seq, ${owedMarkSql(sql`i`)} AS owed
      FROM issues i
     WHERE i.project_id = ${projectId}::uuid AND i.merged_at IS NULL AND i.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM repo_pull_request_issues l
                     JOIN repo_pull_requests p ON p.id = l.pull_request_id
                    WHERE l.issue_id = i.id AND p.state = 'merged')
     ORDER BY i.iss_seq
  `)) as unknown as Array<{ id: string; iss_seq: number; owed: OwedMark | null }>;
  const owed = rows.filter((r) => r.owed !== null);
  if (owed.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId);
  return owed.map((r) => ({
    ...(r.owed as OwedMark),
    issueId: r.id,
    key: formatIssueRef(prefix, Number(r.iss_seq)),
  }));
}

/**
 * After an agent's mark on `issueId`: the change-request release claiming it closes where its last
 * request merged and every mark it waits on is in. The mark is one of the two writes that may close
 * it, Forge's own merge route the other; the host's report of a merge is neither.
 */
export async function settleReleaseOnMark(issueId: string, actor: TransitionActor): Promise<void> {
  const [row] = await db
    .select({ runId: issues.releaseBatchRunId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.runId) await settleChangeRequestRelease(row.runId, actor);
}
