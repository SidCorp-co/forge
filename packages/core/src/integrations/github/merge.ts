import { logger } from '../../observability/logger.js';
import type { HostMergeArgs, HostMergeResult } from '../source-host/index.js';
import type { GitHubRepoClient } from './client.js';
import { decideMerge } from './merge-eligibility.js';
import { readHeadChecks, readProtection, readPullRequest } from './merge-read.js';
import { describeMergeRefusal, type MergeCallRefusal } from './merge-refusal.js';

/** GitHub's three ways of landing a branch. Nothing here invents a fourth. */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

interface MergeAnswer {
  sha?: string;
  merged?: boolean;
  message?: string;
}

const refused = (reason: string, detail: string): HostMergeResult => ({
  kind: 'refused',
  reason,
  detail,
});

/**
 * Merge one pull request as the App, on GitHub's own say-so: read it, decide on its protection and
 * head checks, merge conditionally on the head that was judged, and read GitHub's merge time back.
 * Recording the landing is the caller's (`source-host/merge.ts`), which every host shares.
 */
export async function mergeGitHubPullRequest(
  client: GitHubRepoClient,
  args: HostMergeArgs,
): Promise<HostMergeResult> {
  const { number } = args;
  let pull: Awaited<ReturnType<typeof readPullRequest>>;
  try {
    pull = await readPullRequest(client, number);
  } catch (err) {
    const refusal: MergeCallRefusal = describeMergeRefusal(err, number);
    return refused(refusal.cause, refusal.message);
  }

  if (pull.merged) {
    const commitSha = pull.mergeCommitSha;
    const mergedAt = pull.mergedAt ? new Date(pull.mergedAt) : null;
    if (!commitSha || !mergedAt || Number.isNaN(mergedAt.getTime())) {
      return refused(
        'merged-without-evidence',
        `GitHub reports #${number} merged but sent no merge commit or no merge time, so there is nothing to record as evidence`,
      );
    }
    return { kind: 'already-merged', commitSha, mergedAt };
  }

  let decision: ReturnType<typeof decideMerge>;
  try {
    const [protection, headChecks] = await Promise.all([
      readProtection(client, pull.baseRef),
      readHeadChecks(client, pull.headSha),
    ]);
    decision = decideMerge({
      pull,
      protection,
      headChecks,
      ...(args.expectedHeadSha ? { expectedHeadSha: args.expectedHeadSha } : {}),
    });
  } catch (err) {
    const refusal: MergeCallRefusal = describeMergeRefusal(err, number);
    return refused(refusal.cause, refusal.message);
  }

  if (decision.kind === 'already-merged') {
    return refused(
      'merged-without-evidence',
      `GitHub reported #${number} as not merged and then as merged within one decision — nothing here can say which is true`,
    );
  }
  if (decision.kind === 'refuse') return refused(decision.reason, decision.detail);

  let answer: MergeAnswer;
  try {
    answer = await client.publish<MergeAnswer>({
      op: 'merge',
      method: 'PUT',
      path: `/repos/${client.owner}/${client.repo}/pulls/${number}/merge`,
      body: { sha: pull.headSha, merge_method: args.method ?? 'merge' },
    });
  } catch (err) {
    const refusal = describeMergeRefusal(err, number);
    logger.warn({ number, cause: refusal.cause, status: refusal.status }, 'merge: GitHub refused');
    return refused(refusal.cause, refusal.message);
  }

  if (answer.merged !== true || !answer.sha) {
    return refused(
      'merge-not-confirmed',
      `GitHub answered the merge of #${number} without confirming it — \`merged: ${String(answer.merged)}\`, \`sha: ${answer.sha ?? 'nothing'}\`${answer.message ? `, message: ${answer.message}` : ''}. Forge records a landing only on GitHub's own confirmation of one.`,
    );
  }

  try {
    const after = await readPullRequest(client, number);
    const reported = after.mergedAt ? new Date(after.mergedAt) : null;
    if (!reported || Number.isNaN(reported.getTime())) {
      throw new Error(`GitHub reported no \`merged_at\` for #${number} after merging it`);
    }
    return { kind: 'merged', commitSha: answer.sha, mergedAt: reported };
  } catch (err) {
    throw new Error(
      `github: pull request #${number} MERGED at ${answer.sha}, and reading back when GitHub ` +
        `merged it failed — the commit is on the base branch and Forge's record of it is not. The ` +
        `\`pull_request.closed\` delivery, or another call to this verb, writes the same evidence ` +
        `without merging again. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
