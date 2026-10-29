import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { designOnlyMarkSql } from './design-delivery.js';

/**
 * Whether the issue row `i` releases through change requests: its project's document declares
 * `release.changeRequests` (`@forge/contracts/releases:releaseThroughChangeRequests`).
 */
export const releasesThroughChangeRequestsSql = (i: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM project_config_documents cfg
   WHERE cfg.project_id = ${i}.project_id
     AND (cfg.document -> 'release' ->> 'changeRequests') = 'true')`;

/** The branch the issue row `i`'s project lands work on: its document's `source.git.defaultBranch`. */
export const targetBranchSql = (i: SQL): SQL => sql`(
  SELECT tc.document -> 'source' -> 'git' ->> 'defaultBranch' FROM project_config_documents tc
   WHERE tc.project_id = ${i}.project_id)`;

/**
 * The host's record that the issue row `i` landed: the merge commit Forge's own merge route wrote
 * (`merged_commit_sha`), or a linked change
 * request the host reports merged into the project's target branch no earlier than the issue's
 * stamp. A request merged before the stamp is an earlier delivery that a reopen superseded, and one
 * merged into any other branch landed nothing (ISS-672).
 */
const hostLandedSql = (i: SQL): SQL => sql`(${i}.merged_commit_sha IS NOT NULL OR EXISTS (
  SELECT 1 FROM repo_pull_request_issues hl
    JOIN repo_pull_requests hp ON hp.id = hl.pull_request_id
   WHERE hl.issue_id = ${i}.id AND hp.state = 'merged' AND hp.base_ref = ${targetBranchSql(i)}
     AND hp.merged_at IS NOT NULL AND hp.merged_at >= ${i}.merged_at))`;

/**
 * The host's merge `commit` names on this project: a change request the host reports merged into
 * `target` with that merge commit, whatever issue it links, answered with that target. Null where no
 * such request carries it.
 */
export async function hostMergeNamed(
  projectId: string,
  commit: string | undefined,
  target: string,
): Promise<{ commitSha: string; mergedAt: Date; target: string } | null> {
  const sha = commit?.trim().toLowerCase();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const [row] = await db
    .select({ sha: repoPullRequests.mergeCommitSha, at: repoPullRequests.mergedAt })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.state, 'merged'),
        eq(repoPullRequests.baseRef, target),
        sql`lower(${repoPullRequests.mergeCommitSha}) = ${sha}`,
      ),
    )
    .limit(1);
  return row?.sha && row.at ? { commitSha: row.sha, mergedAt: row.at, target } : null;
}

/**
 * Whether the issue row `i` reads as landed, the one predicate every "landed" read takes: its
 * standing, the sweeps' strand and owed-close findings, and the `merged` guard. On a project that
 * releases through change requests only the host merges code, so a local `merged_at` alone (a
 * box's mark, or a stamp a reopen predating REQ-63 BC-3 left standing) never reads as landed there;
 * a design approval's stamp lands no code and stands as before. Everywhere else `merged_at` is the
 * landing, as before (REQ-71).
 */
export const landedSql = (i: SQL): SQL => sql`coalesce((${i}.merged_at IS NOT NULL AND (
  NOT ${releasesThroughChangeRequestsSql(i)} OR ${hostLandedSql(i)} OR ${designOnlyMarkSql(i)})), false)`;
