/**
 * The repositories one GitHub App can actually see.
 *
 * An App reaches repositories only through its installations, and an
 * installation only through the repositories its operator granted. So this is
 * the authoritative list of what a project may be bound to — not a search over
 * an account, and never something a person should be retyping into a text box.
 */

import { SourceHostCallError } from '../source-host/index.js';
import {
  appOctokit,
  type GitHubOctokit,
  installationOctokit,
  mintInstallationToken,
  responseOf,
} from './octokit.js';

interface InstallationRepo {
  installationId: number;
  account: string;
  owner: string;
  repo: string;
  fullName: string;
}

const MAX_PAGES_PER_INSTALLATION = 5;
const PER_PAGE = 100;

/** A GitHub refusal is thrown with GitHub's status, never read as an empty answer. */
async function githubJson<T>(octokit: GitHubOctokit, url: string): Promise<T> {
  try {
    return (await octokit.request({ method: 'GET', url })).data as T;
  } catch (err) {
    const answered = responseOf(err);
    if (!answered) throw err;
    throw new SourceHostCallError(
      answered.status,
      `GitHub answered HTTP ${answered.status} for ${url}`,
      err instanceof Error ? err.message : null,
    );
  }
}

async function reposForInstallation(
  octokit: GitHubOctokit,
  installationId: number,
  account: string,
): Promise<{ repos: InstallationRepo[]; truncated: boolean }> {
  const repos: InstallationRepo[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_INSTALLATION; page += 1) {
    const body = await githubJson<{
      total_count?: number;
      repositories?: Array<{ name?: string; full_name?: string; owner?: { login?: string } }>;
    }>(octokit, `/installation/repositories?per_page=${PER_PAGE}&page=${page}`);
    const batch = body.repositories ?? [];
    for (const r of batch) {
      const owner = r.owner?.login;
      const repo = r.name;
      if (!owner || !repo) continue;
      repos.push({
        installationId,
        account,
        owner,
        repo,
        fullName: r.full_name ?? `${owner}/${repo}`,
      });
    }
    if (batch.length < PER_PAGE) return { repos, truncated: false };
  }
  return { repos, truncated: true };
}

/**
 * Every repository reachable through every installation of this App, tagged
 * with the installation that reaches it — a binding needs both, because the
 * installation is what mints the token and the repository is what the project
 * points at.
 */
export async function listInstallationRepositories(args: {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  repositories: InstallationRepo[];
  truncated: boolean;
  failedInstallations: Array<{ installationId: number; account: string; reason: string }>;
}> {
  const installations = await githubJson<Array<{ id?: number; account?: { login?: string } }>>(
    appOctokit(args),
    '/app/installations',
  );
  const out: InstallationRepo[] = [];
  const failedInstallations: Array<{ installationId: number; account: string; reason: string }> =
    [];
  let truncated = false;
  for (const inst of installations) {
    if (typeof inst.id !== 'number') continue;
    const cred = { ...args, installationId: inst.id };
    try {
      await mintInstallationToken(cred);
    } catch (err) {
      // One installation the App cannot act for is named in the answer, not dropped from it.
      const reason = err instanceof Error ? err.message : String(err);
      failedInstallations.push({
        installationId: inst.id,
        account: inst.account?.login ?? '',
        reason,
      });
      continue;
    }
    const page = await reposForInstallation(
      installationOctokit(cred),
      inst.id,
      inst.account?.login ?? '',
    );
    out.push(...page.repos);
    truncated = truncated || page.truncated;
  }

  return { repositories: out, truncated, failedInstallations };
}
