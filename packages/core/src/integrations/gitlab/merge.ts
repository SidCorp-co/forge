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
  const target = mr.target_branch?.trim() ?? '';
  if (!commitSha || !mergedAt || Number.isNaN(mergedAt.getTime()) || !target) {
    const missing = [
      commitSha ? null : 'no landing commit',
      mergedAt && !Number.isNaN(mergedAt.getTime()) ? null : 'no merge time',
      target ? null : 'no target branch',
    ].filter(Boolean);
    return refused(
      'merged-without-evidence',
      `GitLab reports !${iid} merged but sent ${missing.join(' and ')}, so there is no landing to record as evidence: an issue's merge stamp names the commit, when it landed and the branch it landed on`,
    );
  }
  return { kind, commitSha, mergedAt, target, head: mr.sha ?? null };
}

/** How long a merge waits for GitLab to decide a request's mergeability, and how it waits. */
export interface MergeabilityWait {
  /** The whole wait, from the first read. */
  budgetMs: number;
  /** The first pause; each later one doubles, the last cut to what is left of the budget. */
  firstDelayMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * About thirty seconds: GitLab decided each request of a stack it had just reported `unchecked`
 * within 20–40s of the merge below it (canawan-api !5010–!5013, 2026-10-26), and a read waiting
 * longer than this holds the caller's request open past what a caller can tell from a hang.
 */
export const MERGEABILITY_WAIT: MergeabilityWait = {
  budgetMs: 30_000,
  firstDelayMs: 1_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * The request as GitLab answers for it now. `with_merge_status_recheck=true` asks GitLab to
 * recalculate the mergeability asynchronously (it is honoured for a credential allowed to update
 * the request; the single read already asks for that recheck, and the parameter says so
 * explicitly), so a read after a base moved does not stand on the reading from before it.
 */
const readRequest = (client: GitLabClient, path: string) =>
  client.json<MergeRequestBody>('GET', `${path}?with_merge_status_recheck=true`);

const undecided = (mr: MergeRequestBody) =>
  mr.state === 'opened' && UNDECIDED.has(mr.detailed_merge_status ?? '');

/**
 * Re-read an open request while GitLab is still deciding whether it can merge (`UNDECIDED`): after
 * the request below it in a stack merges, GitLab reports `unchecked` until its recheck finishes. The
 * pauses back off from `firstDelayMs` and the whole wait stops at `budgetMs`; what it answers is the
 * last reading and how long it waited, so a refusal can say both.
 */
async function awaitDecision(
  client: GitLabClient,
  path: string,
  first: MergeRequestBody,
  wait: MergeabilityWait,
): Promise<{ mr: MergeRequestBody; waitedMs: number; reads: number }> {
  const started = wait.now();
  let mr = first;
  let reads = 1;
  let delay = wait.firstDelayMs;
  while (undecided(mr)) {
    const left = wait.budgetMs - (wait.now() - started);
    if (left <= 0) break;
    await wait.sleep(Math.min(delay, left));
    delay *= 2;
    mr = await readRequest(client, path);
    reads += 1;
  }
  return { mr, waitedMs: wait.now() - started, reads };
}

/**
 * Merge one merge request with the binding's token, on GitLab's own say-so.
 *
 * Refused before anything is sent: a request that is not open, a draft, a head that moved since the
 * caller judged it, an approval rule still owed, a head pipeline that is not green, and any
 * `detailed_merge_status` but `mergeable` — one GitLab is still deciding only once `wait` is spent
 * (`awaitDecision`). The merge itself is conditional on the judged head
 * (`sha`), so a push landing between the read and the merge is refused by GitLab rather than merged.
 */
export async function mergeGitLabMergeRequest(
  client: GitLabClient,
  args: HostMergeArgs,
  wait: MergeabilityWait = MERGEABILITY_WAIT,
): Promise<HostMergeResult> {
  const iid = args.number;
  const path = client.project(`/merge_requests/${iid}`);
  let mr: MergeRequestBody;
  let waited: { waitedMs: number; reads: number };
  try {
    const decided = await awaitDecision(client, path, await readRequest(client, path), wait);
    mr = decided.mr;
    waited = decided;
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
    const stillDeciding =
      reason === 'mergeability-unknown'
        ? ` — GitLab was asked to recheck it and was read ${waited.reads} time${waited.reads === 1 ? '' : 's'} over ${Math.round(waited.waitedMs / 1000)}s without deciding; merge again once GitLab shows it mergeable`
        : '';
    return refused(
      reason,
      `GitLab reports merge request !${iid} as \`${status ?? 'no detailed_merge_status'}\`, not \`mergeable\`, so it is not merged${stillDeciding}`,
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
