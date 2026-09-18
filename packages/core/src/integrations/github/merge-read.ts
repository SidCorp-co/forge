/**
 * The three things Forge reads from GitHub before it merges. ISS-1073.
 *
 * Here rather than in `merge.ts` so the decision, the reading and the writing
 * are three separable subjects: `merge-eligibility.ts` decides over these
 * shapes, this file produces them, and `merge.ts` is what happens next.
 *
 * Every read goes through `client.publish` rather than `client.get`, and the
 * reason is `client.ts`'s own: `get` collapses an auth failure into a status and
 * throws away which step it came from and the rate-limit headers with it. On the
 * merge path that distinction is what tells an operator whether to grant a
 * permission or to wait.
 */

import type { GitHubRepoClient } from './client.js';
import { GitHubPublishError } from './client.js';
import type { HeadCheck, MergeReadout, ProtectionReadout } from './merge-eligibility.js';

interface PullBody {
  number?: number;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string };
  base?: { ref?: string };
}

/** One pull request as GitHub answers for it right now. */
export async function readPullRequest(
  client: GitHubRepoClient,
  number: number,
): Promise<MergeReadout> {
  const body = await client.publish<PullBody>({
    op: 'lookup',
    method: 'GET',
    path: `/repos/${client.owner}/${client.repo}/pulls/${number}`,
  });
  return {
    number: body.number ?? number,
    state: body.state ?? 'unknown',
    draft: body.draft === true,
    merged: body.merged === true,
    mergeCommitSha: body.merge_commit_sha ?? null,
    mergedAt: body.merged_at ?? null,
    headSha: body.head?.sha ?? '',
    baseRef: body.base?.ref ?? '',
    mergeable: body.mergeable ?? null,
    mergeableState: body.mergeable_state ?? null,
  };
}

interface ProtectionBody {
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  } | null;
}

/**
 * What the base branch requires, or that Forge could not find out.
 *
 * Three answers and not two. A 404 is a real answer — GitHub returns it for a
 * branch with no protection, and an unprotected branch requires nothing. A 403
 * is not an answer: the App is not permitted to read the protection, so Forge
 * cannot tell a satisfied protection from an unsatisfied one, and
 * `merge-eligibility.ts` refuses on it rather than merging on the difference.
 */
// cm:guard the 404 arm is scoped to THIS read and is not a general "absent means fine". It is a documented GitHub answer for an unprotected branch, and it is safe here only because the thing it reports absent — a requirement — has no effect when it is absent. The 403 beside it is the case that looks identical from a distance and means the opposite, which is why the two are written out rather than collapsed into `!ok`.
export async function readProtection(
  client: GitHubRepoClient,
  baseRef: string,
): Promise<ProtectionReadout> {
  try {
    const body = await client.publish<ProtectionBody>({
      op: 'lookup',
      method: 'GET',
      path: `/repos/${client.owner}/${client.repo}/branches/${encodeURIComponent(baseRef)}/protection`,
    });
    const required = body.required_status_checks;
    const contexts = [
      ...(required?.contexts ?? []),
      ...(required?.checks ?? []).map((c) => c.context).filter((c): c is string => Boolean(c)),
    ];
    return { kind: 'protected', requiredChecks: [...new Set(contexts)] };
  } catch (err) {
    if (err instanceof GitHubPublishError && err.status === 404) return { kind: 'unprotected' };
    const why =
      err instanceof GitHubPublishError
        ? `GitHub answered HTTP ${err.status ?? 'nothing'}${err.timedOut ? ' after a timeout' : ''}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { kind: 'unreadable', why };
  }
}

interface CheckRunsBody {
  check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; started_at?: string | null }>;
}

/** Every check run on this head, latest per name first, so a re-run answers for its name. */
// cm:guard one run per NAME, latest `started_at` winning, because a required context names a check and a re-run is the same check answered again. Keeping both would let a first, failing run answer for a name whose re-run went green — and the pull request page would then disagree with Forge about whether the branch is mergeable.
export async function readHeadChecks(
  client: GitHubRepoClient,
  headSha: string,
): Promise<HeadCheck[]> {
  const body = await client.publish<CheckRunsBody>({
    op: 'lookup',
    method: 'GET',
    path: `/repos/${client.owner}/${client.repo}/commits/${headSha}/check-runs?per_page=100`,
  });
  const latest = new Map<string, HeadCheck & { startedAt: number }>();
  for (const run of body.check_runs ?? []) {
    const name = run.name;
    if (!name) continue;
    const startedAt = Date.parse(run.started_at ?? '') || 0;
    const held = latest.get(name);
    if (held && held.startedAt > startedAt) continue;
    latest.set(name, {
      name,
      status: run.status ?? 'queued',
      conclusion: run.conclusion ?? null,
      startedAt,
    });
  }
  return [...latest.values()].map(({ name, status, conclusion }) => ({ name, status, conclusion }));
}
