import type { HostMergeArgs, HostMergeResult } from '../source-host/index.js';
import { SourceHostCallError } from '../source-host/index.js';
import type { GitLabClient } from './client.js';

/** GitLab's two ways of landing a merge request through this API. Rebase is its own verb there. */
export const GITLAB_MERGE_METHODS = ['merge', 'squash'] as const;

export interface MergeRequestBody {
  iid?: number;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  sha?: string | null;
  source_branch?: string;
  target_branch?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  merged_at?: string | null;
  detailed_merge_status?: string | null;
  merge_status?: string | null;
  head_pipeline?: { id?: number; status?: string; sha?: string } | null;
  web_url?: string;
  title?: string;
  updated_at?: string | null;
  diff_refs?: { base_sha?: string | null; head_sha?: string | null } | null;
}

interface ApprovalsBody {
  approved?: boolean;
  approvals_required?: number;
  approvals_left?: number;
}

const refused = (reason: string, detail: string): HostMergeResult => ({
  kind: 'refused',
  reason,
  detail,
});

/** What landed for a merged request: the merge commit, else the squash, else the fast-forwarded head. */
export function landingOf(mr: MergeRequestBody): string | null {
  return mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? null;
}

/** `detailed_merge_status` values that mean GitLab has not finished deciding, not that it said no. */
const UNDECIDED = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);
const CHECKS = new Set([
  'ci_must_pass',
  'ci_still_running',
  'commits_status',
  'external_status_checks',
]);

function callRefusal(err: unknown, iid: number, step: string): HostMergeResult {
  if (err instanceof SourceHostCallError) {
    const said = err.detail ? ` GitLab said: ${err.detail}` : '';
    const reason =
      err.status === 401
        ? 'credential-rejected'
        : err.status === 403
          ? 'not-permitted'
          : err.status === 404
            ? 'not-found'
            : err.status === 405 || err.status === 406 || err.status === 422
              ? 'not-mergeable'
              : err.status === 409
                ? 'head-moved'
                : 'host-error';
    return refused(
      reason,
      `GitLab answered HTTP ${err.status} ${step} merge request !${iid}.${said}`,
    );
  }
  throw err;
}

function mergedResult(
  mr: MergeRequestBody,
  iid: number,
  kind: 'merged' | 'already-merged',
): HostMergeResult {
  const commitSha = landingOf(mr);
  const mergedAt = mr.merged_at ? new Date(mr.merged_at) : null;
  if (!commitSha || !mergedAt || Number.isNaN(mergedAt.getTime())) {
    return refused(
      'merged-without-evidence',
      `GitLab reports !${iid} merged but sent no landing commit or no merge time, so there is nothing to record as evidence`,
    );
  }
  return { kind, commitSha, mergedAt };
}

/**
 * Merge one merge request with the binding's token, on GitLab's own say-so.
 *
 * Refused before anything is sent: a request that is not open, a draft, a head that moved since the
 * caller judged it, an approval rule still owed, a head pipeline that is not green, and any
 * `detailed_merge_status` but `mergeable`. The merge itself is conditional on the judged head
 * (`sha`), so a push landing between the read and the merge is refused by GitLab rather than merged.
 */
export async function mergeGitLabMergeRequest(
  client: GitLabClient,
  args: HostMergeArgs,
): Promise<HostMergeResult> {
  const iid = args.number;
  const path = client.project(`/merge_requests/${iid}`);
  let mr: MergeRequestBody;
  try {
    mr = await client.json<MergeRequestBody>('GET', path);
  } catch (err) {
    return callRefusal(err, iid, 'reading');
  }

  if (mr.state === 'merged') return mergedResult(mr, iid, 'already-merged');
  if (mr.state !== 'opened') {
    return refused(
      'not-open',
      `merge request !${iid} on ${client.fullName} is ${mr.state ?? 'in no state GitLab named'}, not open, so there is nothing to merge`,
    );
  }
  if (mr.draft === true || mr.work_in_progress === true) {
    return refused(
      'draft',
      `merge request !${iid} is a draft — mark it ready on GitLab before Forge merges it`,
    );
  }
  const head = mr.sha ?? '';
  if (args.expectedHeadSha && !head.toLowerCase().startsWith(args.expectedHeadSha.toLowerCase())) {
    return refused(
      'head-moved',
      `merge request !${iid}'s head is ${head || 'unknown'}, and this merge was judged at ${args.expectedHeadSha} — a head that moved is refused, never re-aimed`,
    );
  }

  let approvals: ApprovalsBody;
  try {
    approvals = await client.json<ApprovalsBody>('GET', `${path}/approvals`);
  } catch (err) {
    if (err instanceof SourceHostCallError) {
      return refused(
        'approvals-unreadable',
        `GitLab answered HTTP ${err.status} for merge request !${iid}'s approvals, so Forge cannot tell an approved request from one still owed an approval, and does not merge on the difference`,
      );
    }
    throw err;
  }
  const left = approvals.approvals_left ?? 0;
  if (left > 0) {
    return refused(
      'not-approved',
      `merge request !${iid} still needs ${left} approval${left === 1 ? '' : 's'} of the ${approvals.approvals_required ?? left} its rules require — Forge does not merge a release the owner has not approved`,
    );
  }

  const pipeline = mr.head_pipeline;
  if (pipeline && pipeline.status !== 'success') {
    return refused(
      'checks-not-green',
      `merge request !${iid}'s head pipeline ${pipeline.id ?? ''} is ${pipeline.status ?? 'in no state'}, not success`,
    );
  }

  const status = mr.detailed_merge_status ?? null;
  if (status !== 'mergeable') {
    const reason =
      status === 'not_approved'
        ? 'not-approved'
        : status === 'draft_status'
          ? 'draft'
          : status && UNDECIDED.has(status)
            ? 'mergeability-unknown'
            : status && CHECKS.has(status)
              ? 'checks-not-green'
              : 'not-mergeable';
    return refused(
      reason,
      `GitLab reports merge request !${iid} as \`${status ?? 'no detailed_merge_status'}\`, not \`mergeable\`, so it is not merged`,
    );
  }

  let after: MergeRequestBody;
  try {
    after = await client.json<MergeRequestBody>('PUT', `${path}/merge`, {
      sha: head,
      squash: args.method === 'squash',
      should_remove_source_branch: false,
    });
  } catch (err) {
    return callRefusal(err, iid, 'merging');
  }
  if (after.state !== 'merged') {
    return refused(
      'merge-not-confirmed',
      `GitLab answered the merge of !${iid} with state \`${after.state ?? 'nothing'}\` — Forge records a landing only on GitLab's own confirmation of one`,
    );
  }
  return mergedResult(after, iid, 'merged');
}
