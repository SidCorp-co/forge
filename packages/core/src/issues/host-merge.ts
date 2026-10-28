import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  repoPullRequestIssues,
  repoPullRequestIssueUnlinks,
  repoPullRequests,
} from '../db/schema-repo-projection.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { insertIssueRow } from './create-service.js';
import { issueGateOf } from './gates.js';
import { resolveIssuesForChangeRequest } from './head-ref-link.js';
import { type MergeIdentity, mergeIdentityOf, recordRefusedStamp } from './merge-identity.js';
import { recordIssueMerge } from './merge-record.js';
import { linkFiledIssueToChangeRequest, projectCreatorOf, readLandingBranches } from './ports.js';

/**
 * Every issue the merged branch delivers: each one Forge's record of its change request links, and
 * each one the branch name itself names, for a request the projection has not read yet (REQ-63 BC-4).
 * An issue a person unlinked from a request on this branch is not delivered by it (ISS-705), even
 * where the branch names it.
 */
async function issuesDelivered(executor: Tx | typeof db, projectId: string, headRef: string) {
  const onBranch = and(
    eq(repoPullRequests.projectId, projectId),
    eq(repoPullRequests.headRef, headRef),
  );
  const linked = await executor
    .selectDistinct({ issueId: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(onBranch);
  const unlinked = await executor
    .selectDistinct({ issueId: repoPullRequestIssueUnlinks.issueId })
    .from(repoPullRequestIssueUnlinks)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssueUnlinks.pullRequestId))
    .where(and(onBranch, isNull(repoPullRequestIssueUnlinks.relinkedAt)));
  const off = new Set(unlinked.map((r) => r.issueId));
  const named = await resolveIssuesForChangeRequest({ projectId, headRef });
  return [
    ...new Set([
      ...linked.map((r) => r.issueId),
      ...named.map((l) => l.issueId).filter((id) => !off.has(id)),
    ]),
  ];
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
  // a request out of the landing branch (or a declared promotion's source) carries what already
  // landed further, so it stamps nobody's landing: adminhub-api !5020 overwrote ISS-23/24/25's
  // own merges on release/stg with the promotion into release/production (REQ-45 BC-16)
  const { promotes } = await readLandingBranches(args.projectId);
  if (promotes.includes(args.headRef) && args.baseRef !== args.headRef) {
    logger.info(
      { projectId: args.projectId, headRef: args.headRef, baseRef: args.baseRef },
      'source.merged: a promotion of landed work, which is no issue’s landing',
    );
    return [];
  }
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

/** What a merge naming no issue files, read before the stamp's transaction opens. */
interface MergeFiling {
  title: string;
  description: string;
  pullRequestId: string | null;
}

/** The detector key a merge-born issue carries: one issue per landing commit, whatever redelivers it. */
export const mergeBornKey = (commitSha: string) => `merged/${commitSha.toLowerCase()}`;

/**
 * Act first, record after (REQ-76 BC-8): where the project's gate `issue_before_code` is off (yolo),
 * a merge onto its base branch that delivers no issue files one, titled from the change request,
 * so Forge records the work an agent did straight away. Under strict and standard (the gate
 * enforced) such a merge records nothing, as before. A promotion carries landed work and files nothing.
 */
async function mergeFilingOf(args: HostMergeReport): Promise<MergeFiling | null> {
  const gate = await issueGateOf(args.projectId, 'issue_before_code');
  if (gate.mode === 'enforce') return null;
  const { defaultBranch, promotes } = await readLandingBranches(args.projectId);
  if (!defaultBranch || args.baseRef !== defaultBranch || promotes.includes(args.headRef))
    return null;
  const [pr] = await db
    .select({
      id: repoPullRequests.id,
      number: repoPullRequests.number,
      title: repoPullRequests.title,
      htmlUrl: repoPullRequests.htmlUrl,
    })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, args.projectId),
        eq(repoPullRequests.headRef, args.headRef),
        eq(repoPullRequests.baseRef, defaultBranch),
      ),
    )
    .orderBy(desc(repoPullRequests.updatedAt))
    .limit(1);
  const change = pr
    ? `change request #${pr.number}${pr.htmlUrl ? ` (${pr.htmlUrl})` : ''}`
    : `the merge of \`${args.headRef}\``;
  return {
    title: (pr?.title.trim() || `Merge of ${args.headRef} into ${defaultBranch}`).slice(0, 200),
    description: [
      `Filed by Forge from ${change}, merged into \`${defaultBranch}\` at \`${args.commitSha}\` naming no issue.`,
      `This project's gate profile lets an agent change code first (gate \`issue_before_code\` off), so the issue is recorded after the work: its landing is the merge itself. Claim it and move it to \`awaiting_release\`, and a release ships and closes it like any merged issue.`,
    ].join('\n\n'),
    pullRequestId: pr?.id ?? null,
  };
}

/** The merge-born issue, its link to the change request and its landing, in the stamp's transaction. */
async function fileFromMerge(
  args: HostMergeReport,
  filing: MergeFiling,
  tx: Tx,
): Promise<string[]> {
  const target = assertReport(args);
  const detectorKey = mergeBornKey(args.commitSha);
  const [filed] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, args.projectId), eq(issues.detectorKey, detectorKey)))
    .limit(1);
  if (filed) return [];
  const creator = await projectCreatorOf(args.projectId);
  if (!creator) {
    throw new Error(
      `source.merged for ${args.headRef} at ${args.commitSha}: project ${args.projectId} names no owner, and an issue filed from a merge is recorded on the owner's behalf — nothing is filed with no actor on its record`,
    );
  }
  const actor = { type: 'user' as const, id: creator, agency: 'agent' as const };
  const issue = await insertIssueRow(
    tx,
    {
      projectId: args.projectId,
      title: filing.title,
      description: filing.description,
      descriptionFormat: 'markdown',
      status: 'open',
      createdById: creator,
      createdByDeviceId: null,
      createdVia: 'system',
      detectorKey,
    },
    { actor },
  );
  if (filing.pullRequestId) {
    await linkFiledIssueToChangeRequest(tx, {
      pullRequestId: filing.pullRequestId,
      issueId: issue.id,
    });
  }
  await recordIssueMerge(tx, {
    issueId: issue.id,
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
  return [issue.id];
}

/** The issues kernel's reaction to a merge a source host reported. */
export function registerHostMergeStamp(): void {
  consume('source.merged', {
    name: 'issue-merge-stamp',
    handle: async (p, d) => {
      const report = { ...p, mergedAt: new Date(p.mergedAt) };
      assertReport(report);
      const judged = await judgeHostMerge(report);
      const filing = judged.length === 0 ? await mergeFilingOf(report) : null;
      await d.inbox((tx) =>
        filing ? fileFromMerge(report, filing, tx) : stampHostMerge(report, judged, tx),
      );
    },
  });
}
