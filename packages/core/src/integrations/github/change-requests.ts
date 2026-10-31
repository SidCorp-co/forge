import type { HostCheck, ReadChangeRequest, SourceHost } from '../source-host/index.js';
import { refuseSourceHostInput } from '../source-host/index.js';
import type { GitHubAgentClient } from './agent-client.js';
import type { GitHubRepoClient } from './client.js';

/** Check runs past this many pages of a hundred are not read: GitHub lists a commit's newest first. */
const CHECK_RUN_MAX_PAGES = 10;

interface PullBody {
  number?: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  updated_at?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string };
}

interface CheckRunsPage {
  total_count?: number;
  check_runs?: Array<{
    id?: number;
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    details_url?: string | null;
    html_url?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    app?: { slug?: string } | null;
  }>;
}

interface CombinedStatus {
  statuses?: Array<{
    id?: number;
    context?: string;
    state?: string;
    target_url?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;
}

/** The pull request as GitHub answered for it, in the port's words. */
export function readOfPull(pull: PullBody, number: number): ReadChangeRequest {
  const merged = pull.merged === true || Boolean(pull.merged_at);
  return {
    number: pull.number ?? number,
    url: pull.html_url ?? null,
    title: pull.title ?? '',
    state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    draft: pull.draft === true,
    headRef: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? null,
    baseRef: pull.base?.ref ?? '',
    baseSha: pull.base?.sha ?? null,
    updatedAt: pull.updated_at ?? null,
    body: pull.body ?? null,
    mergedAt: merged ? (pull.merged_at ?? null) : null,
    mergeCommitSha: merged ? (pull.merge_commit_sha ?? null) : null,
  };
}

/** A commit status as a check: `pending` is running, every other state is its conclusion. */
function checkOfStatus(
  sha: string,
  s: NonNullable<CombinedStatus['statuses']>[number] & { id: number },
): HostCheck {
  const done = s.state !== 'pending';
  return {
    id: `status-${s.id}`,
    name: s.context ?? '(unnamed status)',
    app: 'commit-status',
    headSha: sha,
    status: done ? 'completed' : 'in_progress',
    conclusion: done ? (s.state ?? null) : null,
    detailsUrl: s.target_url ?? null,
    startedAt: s.created_at ?? null,
    completedAt: done ? (s.updated_at ?? null) : null,
  };
}

async function checkRunsOf(client: GitHubRepoClient, sha: string): Promise<HostCheck[]> {
  const out: HostCheck[] = [];
  const base = `/repos/${client.fullName}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
  for (let page = 1; page <= CHECK_RUN_MAX_PAGES; page += 1) {
    const read = await client.get<CheckRunsPage>(`${base}&page=${page}`);
    const runs = read.check_runs ?? [];
    for (const run of runs) {
      if (typeof run.id !== 'number') continue;
      out.push({
        id: String(run.id),
        name: run.name ?? '(unnamed check)',
        app: run.app?.slug ?? 'unknown',
        headSha: run.head_sha ?? sha,
        status: run.status ?? 'queued',
        conclusion: run.conclusion ?? null,
        detailsUrl: run.details_url ?? run.html_url ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
      });
    }
    if (runs.length < 100 || out.length >= (read.total_count ?? 0)) break;
  }
  return out;
}

type ChangeRequestVerbs = Pick<
  SourceHost,
  | 'readChecks'
  | 'readChangeRequestChecks'
  | 'readChangeRequest'
  | 'updateChangeRequest'
  | 'closeChangeRequest'
>;

/**
 * A pull request read, edited or closed by its number, and a commit's checks: its check runs and
 * the commit statuses an outside CI posts, the latest status per context as GitHub combines them.
 * Reads go as the repository client the kernel reads with; the writes as the agent's App client.
 */
export function githubChangeRequestVerbs(
  client: GitHubRepoClient,
  agent: () => GitHubAgentClient,
): ChangeRequestVerbs {
  const pullPath = (n: number) => `/repos/${client.fullName}/pulls/${n}`;
  const read = async (number: number) =>
    readOfPull(await client.get<PullBody>(pullPath(number)), number);
  const write = async (number: number, body: Record<string, unknown>) => {
    const app = agent();
    return readOfPull(
      await app.json<PullBody>({
        method: 'PATCH',
        path: `/repos/${app.owner}/${app.repo}/pulls/${number}`,
        body,
      }),
      number,
    );
  };

  const statusesOf = async (sha: string): Promise<HostCheck[]> => {
    const combined = await client.get<CombinedStatus>(
      `/repos/${client.fullName}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
    );
    return (combined.statuses ?? []).flatMap((s) =>
      typeof s.id === 'number' ? [checkOfStatus(sha, { ...s, id: s.id })] : [],
    );
  };

  // A check named by the caller that GitHub holds as a check run (every GitHub Actions job) is
  // answered by the check runs alone. Commit statuses need `statuses: read`, which a repository
  // credential may lack, and they never carry an Actions job: asking them anyway turned a green
  // Actions gate into a refusal on agenfold (ISS-841, FB-437). A name no check run carries is still
  // looked for among the statuses, and a status read that fails then fails the whole read.
  const readChecks = async (sha: string, opts: { named?: string } = {}): Promise<HostCheck[]> => {
    if (opts.named === undefined) {
      const [runs, statuses] = await Promise.all([checkRunsOf(client, sha), statusesOf(sha)]);
      return [...runs, ...statuses];
    }
    const runs = await checkRunsOf(client, sha);
    if (runs.some((r) => r.name === opts.named)) return runs;
    return [...runs, ...(await statusesOf(sha))];
  };

  return {
    readChecks,
    // GitHub runs a pull request's checks on its head commit itself, so the head's checks are all of them
    readChangeRequestChecks: ({ headSha, named }) =>
      readChecks(headSha, named === undefined ? {} : { named }),

    readChangeRequest: read,

    updateChangeRequest: ({ number, title, body }) =>
      write(number, {
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
      }),

    async closeChangeRequest({ number }) {
      const now = await read(number);
      if (now.state === 'merged') {
        throw refuseSourceHostInput(
          `pull request #${number} on ${client.fullName} is merged, and closing cannot take a landing back — it is left as it is`,
        );
      }
      if (now.state === 'closed') return now;
      return write(number, { state: 'closed' });
    },
  };
}
