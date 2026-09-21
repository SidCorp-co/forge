import type { GitHubAgentClient } from './agent-client.js';
import { GitHubAgentCallError } from './agent-client.js';

/** A diff over this is sliced from the top, and the whole length is reported beside the slice. */
export const DIFF_CAP_BYTES = 256 * 1024;

/** A job log is read up to this FROM ITS END, then tailed to the lines asked for. */
const LOG_CAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOG_LINES = 100;

/**
 * The verbs this face refuses BY NAME rather than by schema, and the sentence each one gets.
 *
 * ISS-1074's outcome 4: nothing an agent does through this face can merge. A `z.enum` that simply
 * does not list `merge` refuses it too — with a list of seven strings and no reason, which reads to
 * a caller as a tool that is missing a verb rather than as a boundary it just met. The refusal IS
 * the deliverable here, so the name is recognised in order to be answered.
 */
const KERNEL_VERBS = new Set([
  'merge',
  'merge-pull-request',
  'squash',
  'rebase',
  'close',
  'close-pull-request',
  'delete-branch',
]);

export function isKernelVerb(action: string): boolean {
  return KERNEL_VERBS.has(action);
}

export function kernelVerbRefusal(action: string): string {
  return (
    `\`${action}\` is not one of this tool's actions and will not become one. Merging a pull request ` +
    'is a kernel transition on the DISPATCH face, where the same operation that merges also stamps ' +
    '`merged_at` and the commit it landed at — one writer for one truth — so it happens without an ' +
    'agent present and is recorded whether or not one was. It is served there as the outbound verb ' +
    '`pull_request.merge`, not here. What this face carries is the judgement: read the diff, read a ' +
    "failing check run's log, comment, open a pull request, request a review, submit a verdict. " +
    'Opening one does reach a writer, and the same one a webhook delivery reaches: the request is ' +
    "stored on Forge's projection of the repository as it is created, which is what leaves the " +
    'kernel a pull request it can be asked to merge later.'
  );
}

export interface PullRequestDiff {
  number: number;
  repository: string;
  /** The length of the whole redacted answer, not of `diff`. */
  bytes: number;
  truncated: boolean;
  /** The diff, redacted and then capped from the top. */
  diff: string;
}

/**
 * One pull request's diff, as the App — redacted, then capped from the top.
 *
 * A diff is third-party text as much as a log is: a contributor who committed a `.env`, or a
 * workflow file carrying a token, puts a live credential in it, and this face hands what it reads
 * to an agent that will quote it. The redaction is `client.text`'s and runs on everything GitHub
 * sent before the cap, so there is one place it happens rather than one per caller.
 */
export async function readPullRequestDiff(
  client: GitHubAgentClient,
  args: { number: number; maxBytes?: number },
): Promise<PullRequestDiff> {
  const got = await client.text({
    path: `/repos/${client.owner}/${client.repo}/pulls/${args.number}`,
    accept: 'application/vnd.github.v3.diff',
    maxBytes: args.maxBytes ?? DIFF_CAP_BYTES,
  });
  return {
    number: args.number,
    repository: client.fullName,
    bytes: got.bytes,
    truncated: got.truncated,
    diff: got.body,
  };
}

interface CheckRunBody {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

export interface CheckRunLog {
  checkRunId: number;
  name: string;
  app: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  /** What the check itself published, which is all Forge has when the log cannot be fetched. */
  summary: string | null;
  /** The tail, scrubbed — or null, with `refusal` saying why. */
  log: string | null;
  truncated: boolean;
  /** Why there is no log. Null where there is one. An absence with a reason beside it. */
  refusal: string | null;
}

/**
 * The GitHub Actions job id a check run's `details_url` names, or null.
 *
 * Read out of the URL rather than assumed equal to the check-run id. The two are the same number
 * for an Actions job today, and a tool that relies on that is relying on an identity GitHub has
 * never documented; `details_url` is `…/actions/runs/<runId>/job/<jobId>` and says which job it is.
 */
export function actionsJobId(detailsUrl: string | null | undefined): number | null {
  const hit = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(detailsUrl ?? '');
  const id = hit?.[1];
  return id ? Number(id) : null;
}

/** The last `lines` lines of `text`, and whether anything was dropped. */
export function tailLines(text: string, lines: number): { text: string; truncated: boolean } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, truncated: false };
  return { text: all.slice(all.length - lines).join('\n'), truncated: true };
}

/** A failing check run's log, scrubbed and tailed — or the reason Forge cannot fetch it. */
export async function readCheckRunLog(
  client: GitHubAgentClient,
  args: { checkRunId: number; lines?: number },
): Promise<CheckRunLog> {
  const run = await client.json<CheckRunBody>({
    method: 'GET',
    path: `/repos/${client.owner}/${client.repo}/check-runs/${args.checkRunId}`,
  });
  const base = {
    checkRunId: args.checkRunId,
    name: run.name ?? '(unnamed check)',
    app: run.app?.slug ?? 'unknown',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion ?? null,
    detailsUrl: run.details_url ?? run.html_url ?? null,
    summary: run.output?.summary ?? null,
  };

  const jobId = actionsJobId(base.detailsUrl);
  if (jobId === null) {
    return {
      ...base,
      log: null,
      truncated: false,
      refusal:
        `check run ${args.checkRunId} was published by \`${base.app}\` and its details URL names no ` +
        'GitHub Actions job, so Forge has no log endpoint to read. Forge fetches a log only for an ' +
        `Actions job. What the check itself published is in \`summary\`; the rest is at ${base.detailsUrl ?? 'no URL GitHub gave'}.`,
    };
  }

  let raw: { body: string; bytes: number; truncated: boolean };
  try {
    raw = await client.text({
      path: `/repos/${client.owner}/${client.repo}/actions/jobs/${jobId}/logs`,
      accept: 'application/vnd.github+json',
      maxBytes: LOG_CAP_BYTES,
      keep: 'tail',
    });
  } catch (err) {
    if (err instanceof GitHubAgentCallError) {
      return {
        ...base,
        log: null,
        truncated: false,
        refusal:
          `GitHub answered HTTP ${err.status} for the log of Actions job ${jobId}. A 404 or 410 here ` +
          'is a log GitHub has expired or a job it has removed, and a 403 is a permission the App ' +
          `installation does not hold on ${client.fullName}. Nothing was retried. What the check ` +
          'itself published is in `summary`.',
      };
    }
    throw err;
  }

  const tailed = tailLines(raw.body, args.lines ?? DEFAULT_LOG_LINES);
  return {
    ...base,
    log: tailed.text,
    truncated: tailed.truncated || raw.truncated,
    refusal: null,
  };
}

export interface WrittenComment {
  commentId: number;
  url: string | null;
}

/** A comment on the pull request's conversation, written as the App. */
export async function writePullRequestComment(
  client: GitHubAgentClient,
  args: { number: number; body: string },
): Promise<WrittenComment> {
  // The `issues/comments` path is right for a pull request: GitHub's conversation thread on a pull
  // request IS its issue thread. `pulls/comments` is the review-line thread, a different object.
  const written = await client.json<{ id?: number; html_url?: string }>({
    method: 'POST',
    path: `/repos/${client.owner}/${client.repo}/issues/${args.number}/comments`,
    body: { body: args.body },
  });
  return { commentId: written.id ?? 0, url: written.html_url ?? null };
}

export interface OpenedPullRequest {
  number: number;
  url: string | null;
  title: string;
  state: string;
  draft: boolean;
  headRef: string;
  /** The commit the branch stood at when GitHub opened the request. */
  headSha: string | null;
  baseRef: string;
  baseSha: string | null;
  /**
   * GitHub's own `updated_at` for the request it just created.
   *
   * Carried because the projection's upsert orders deliveries on it and treats an ABSENT one as
   * always-wins: a creation write reaching the row after a later `pull_request` delivery would
   * overwrite that delivery's state, head and merge evidence without it.
   */
  updatedAt: string | null;
}

/** Open a pull request as the App. Opening is not merging, and nothing here lands anything. */
export async function openPullRequest(
  client: GitHubAgentClient,
  args: { head: string; base: string; title: string; body?: string; draft?: boolean },
): Promise<OpenedPullRequest> {
  const made = await client.json<{
    number?: number;
    html_url?: string;
    title?: string;
    state?: string;
    draft?: boolean;
    updated_at?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string; sha?: string };
  }>({
    method: 'POST',
    path: `/repos/${client.owner}/${client.repo}/pulls`,
    body: {
      title: args.title,
      head: args.head,
      base: args.base,
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.draft === undefined ? {} : { draft: args.draft }),
    },
  });
  return {
    number: made.number ?? 0,
    url: made.html_url ?? null,
    title: made.title ?? args.title,
    state: made.state ?? 'open',
    draft: made.draft === true,
    headRef: made.head?.ref ?? args.head,
    headSha: made.head?.sha ?? null,
    baseRef: made.base?.ref ?? args.base,
    baseSha: made.base?.sha ?? null,
    updatedAt: made.updated_at ?? null,
  };
}

export interface RequestedReview {
  number: number;
  requestedReviewers: string[];
  requestedTeams: string[];
}

/** Ask named people or teams to review. */
export async function requestReview(
  client: GitHubAgentClient,
  args: { number: number; reviewers?: string[]; teamReviewers?: string[] },
): Promise<RequestedReview> {
  const answered = await client.json<{
    requested_reviewers?: Array<{ login?: string }>;
    requested_teams?: Array<{ slug?: string }>;
  }>({
    method: 'POST',
    path: `/repos/${client.owner}/${client.repo}/pulls/${args.number}/requested_reviewers`,
    body: {
      ...(args.reviewers?.length ? { reviewers: args.reviewers } : {}),
      ...(args.teamReviewers?.length ? { team_reviewers: args.teamReviewers } : {}),
    },
  });
  return {
    number: args.number,
    requestedReviewers: (answered.requested_reviewers ?? [])
      .map((r) => r.login)
      .filter((l): l is string => typeof l === 'string'),
    requestedTeams: (answered.requested_teams ?? [])
      .map((t) => t.slug)
      .filter((s): s is string => typeof s === 'string'),
  };
}

/** The three verdicts a review carries. `APPROVE` is a verdict; it lands nothing. */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmittedReview {
  reviewId: number;
  state: string;
  url: string | null;
  submittedAt: string | null;
  reviewer: string;
  /** The head branch of the pull request reviewed — what resolves the issue this belongs to. */
  headRef: string;
  number: number;
  repository: string;
}

/**
 * Submit a review verdict as the App, and report the head branch it was submitted on.
 *
 * The pull request is read FIRST, for its head ref. The read is not decoration: the head branch is
 * the only thing a pull request and an issue reliably share (`issue-link.ts`), so without it the
 * caller cannot write this review onto the issue and the second half of "one record instead of two"
 * would depend on a webhook echo arriving.
 */
export async function submitReview(
  client: GitHubAgentClient,
  args: { number: number; event: ReviewEvent; body: string },
): Promise<SubmittedReview> {
  const pull = await client.json<{ head?: { ref?: string } }>({
    method: 'GET',
    path: `/repos/${client.owner}/${client.repo}/pulls/${args.number}`,
  });
  const review = await client.json<{
    id?: number;
    state?: string;
    html_url?: string;
    submitted_at?: string | null;
    user?: { login?: string } | null;
  }>({
    method: 'POST',
    path: `/repos/${client.owner}/${client.repo}/pulls/${args.number}/reviews`,
    body: { event: args.event, body: args.body },
  });
  return {
    reviewId: review.id ?? 0,
    state: (review.state ?? args.event).toLowerCase(),
    url: review.html_url ?? null,
    submittedAt: review.submitted_at ?? null,
    reviewer: review.user?.login ?? '(the Forge App)',
    headRef: pull.head?.ref ?? '',
    number: args.number,
    repository: client.fullName,
  };
}
