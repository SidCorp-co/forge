import { logger } from '../../observability/logger.js';
import type { HostMergeArgs, HostMergeResult } from '../source-host/index.js';
import type { GitHubRepoClient } from './client.js';
import { decideMerge } from './merge-eligibility.js';
import { readHeadChecks, readProtection, readPullRequest } from './merge-read.js';
import { describeMergeRefusal, type MergeCallRefusal } from './merge-refusal.js';

/** GitHub's three ways of landing a branch. Nothing here invents a fourth. */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;

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

type Pull = Awaited<ReturnType<typeof readPullRequest>>;

function alreadyMerged(pull: Pull, number: number): HostMergeResult {
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

/** Judge the pull on its base's protection and its head's checks; a refusal is returned, a go is null. */
async function judge(
  client: GitHubRepoClient,
  pull: Pull,
  args: HostMergeArgs,
): Promise<HostMergeResult | null> {
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
    const refusal: MergeCallRefusal = describeMergeRefusal(err, args.number);
    return refused(refusal.cause, refusal.message);
  }
  if (decision.kind === 'already-merged') {
    return refused(
      'merged-without-evidence',
      `GitHub reported #${args.number} as not merged and then as merged within one decision — nothing here can say which is true`,
    );
  }
  return decision.kind === 'refuse' ? refused(decision.reason, decision.detail) : null;
}

/**
 * The merge time is read back from GitHub rather than taken from the clock. A failure here comes
 * AFTER the merge, so it is thrown loudly rather than reported as a refusal.
 */
async function readBack(
  client: GitHubRepoClient,
  number: number,
  sha: string,
): Promise<HostMergeResult> {
  try {
    const after = await readPullRequest(client, number);
    const reported = after.mergedAt ? new Date(after.mergedAt) : null;
    if (!reported || Number.isNaN(reported.getTime())) {
      throw new Error(`GitHub reported no \`merged_at\` for #${number} after merging it`);
    }
    return { kind: 'merged', commitSha: sha, mergedAt: reported };
  } catch (err) {
    throw new Error(
      `github: pull request #${number} MERGED at ${sha}, and reading back when GitHub ` +
        `merged it failed — the commit is on the base branch and Forge's record of it is not. The ` +
        `\`pull_request.closed\` delivery, or another call to this verb, writes the same evidence ` +
        `without merging again. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

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
  let pull: Pull;
  try {
    pull = await readPullRequest(client, number);
  } catch (err) {
    const refusal: MergeCallRefusal = describeMergeRefusal(err, number);
    return refused(refusal.cause, refusal.message);
  }
  if (pull.merged) return alreadyMerged(pull, number);
  const refusal = await judge(client, pull, args);
  if (refusal) return refusal;

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
  return readBack(client, number, answer.sha);
}
