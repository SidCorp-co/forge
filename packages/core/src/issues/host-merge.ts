import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { consume } from '../outbox/index.js';
import { resolveIssuesForChangeRequest } from './head-ref-link.js';
import { type MergeIdentity, mergeIdentityOf, recordRefusedStamp } from './merge-identity.js';
import { recordIssueMerge } from './merge-record.js';
import { projectCreatorOf } from './ports.js';

/**
 * Every issue the merged branch delivers: each one Forge's record of its change request links, and
 * each one the branch name itself names, for a request the projection has not read yet (REQ-63 BC-4).
 */
async function issuesDelivered(executor: Tx | typeof db, projectId: string, headRef: string) {
  const linked = await executor
    .selectDistinct({ issueId: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(and(eq(repoPullRequests.projectId, projectId), eq(repoPullRequests.headRef, headRef)));
  const named = await resolveIssuesForChangeRequest({ projectId, headRef });
  return [...new Set([...linked.map((r) => r.issueId), ...named.map((l) => l.issueId)])];
}

type HostMergeReport = {
  projectId: string;
  headRef: string;
  baseRef: string | undefined;
  commitSha: string;
  mergedAt: Date;
  head: MergedHead | null | undefined;
};

/** The report checked before anything is read: kernel evidence is refused whole, by name. */
function assertReport(args: HostMergeReport): string {
  if (Number.isNaN(args.mergedAt.getTime())) {
    throw new Error(
      `source.merged for ${args.headRef} carries a mergedAt that is not a time; the merge stamp is kernel evidence and is not written without one`,
    );
  }
  if (!args.baseRef?.trim()) {
    throw new Error(
      `source.merged for ${args.headRef} at ${args.commitSha} carries no baseRef; the merge stamp names the branch the merge landed on and is not written without one`,
    );
  }
  return args.baseRef;
}

/**
 * Whose landing the reported commit is, judged per issue before the stamp's transaction opens: the
 * judgement reads the commit from the host, which no transaction should wait on.
 */
async function judgeHostMerge(
  args: HostMergeReport,
): Promise<Array<{ issueId: string; identity: MergeIdentity }>> {
  const delivered = await issuesDelivered(db, args.projectId, args.headRef);
  const judge = mergeIdentityOf({ projectId: args.projectId, commitSha: args.commitSha });
  const out: Array<{ issueId: string; identity: MergeIdentity }> = [];
  for (const issueId of delivered) out.push({ issueId, identity: await judge(issueId) });
  return out;
}

/**
 * The merge a source host reports, on the row the kernel's own merge writes: the one stamp for GitHub
 * and GitLab alike. Somebody pressing Merge on the host and Forge merging are one landing arriving by
 * two routes, and they produce one record because both write through `recordIssueMerge` under
 * the same gate (`merged_commit_sha IS NULL`, or an earlier landing a later merge supersedes). It records
 * the commit, the base branch and the head's tree identity on every issue the request delivers and moves no
 * status; a change-request release it was the last merge of is closed by the release's own consumer
 * (`release-batch/change-request-settle.ts`). Answers which issues this call stamped.
 *
 * Each issue is stamped only where the commit is its landing (`merge-identity.ts`): a request
 * sharing this head or this branch, whose links name other issues, does not stamp them with a
 * commit that is not theirs, nor supersede a mark they hold. A refusal is written on the issue.
 */
async function stampHostMerge(
  args: HostMergeReport,
  judged: ReadonlyArray<{ issueId: string; identity: MergeIdentity }>,
  executor: Tx,
): Promise<string[]> {
  const target = assertReport(args);
  const creator = await projectCreatorOf(args.projectId);
  if (!creator) {
    throw new Error(
      `source.merged for ${args.headRef} at ${args.commitSha}: project ${args.projectId} names no owner, and a host-reported stamp is recorded on the owner's behalf — nothing is stamped with no actor on its record`,
    );
  }
  // a host-reported merge is recorded on the project owner's behalf, as the review note is
  const actor = { type: 'user' as const, id: creator, agency: 'agent' as const };
  const stamped: string[] = [];
  for (const { issueId, identity } of judged) {
    if (!identity.holds) {
      await recordRefusedStamp(executor, {
        issueId,
        actor,
        commitSha: args.commitSha,
        target,
        via: 'event',
        refusal: identity,
      });
      continue;
    }
    const stamp = await recordIssueMerge(executor, {
      issueId,
      via: 'event',
      actor,
      evidence: {
        kind: 'observed',
        commitSha: args.commitSha,
        mergedAt: args.mergedAt,
        target,
        hostMerge: { head: args.head ?? null },
      },
    });
    if (stamp.wrote) stamped.push(issueId);
  }
  return stamped;
}

/** The issues kernel's reaction to a merge a source host reported. */
export function registerHostMergeStamp(): void {
  consume('source.merged', {
    name: 'issue-merge-stamp',
    handle: async (p, d) => {
      const report = { ...p, mergedAt: new Date(p.mergedAt) };
      assertReport(report);
      const judged = await judgeHostMerge(report);
      await d.inbox((tx) => stampHostMerge(report, judged, tx));
    },
  });
}
