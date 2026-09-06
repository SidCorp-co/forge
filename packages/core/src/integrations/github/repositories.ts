/**
 * The repositories one GitHub App can actually see.
 *
 * An App reaches repositories only through its installations, and an
 * installation only through the repositories its operator granted. So this is
 * the authoritative list of what a project may be bound to — not a search over
 * an account, and never something a person should be retyping into a text box.
 */

import { buildAppJwt, installationToken } from './app-auth.js';
import { GITHUB_API_BASE } from './types.js';

export interface InstallationRepo {
  installationId: number;
  account: string;
  owner: string;
  repo: string;
  fullName: string;
}

// cm:guard bound the paging — a token that can see thousands of repositories would otherwise walk them all on a screen that renders a dropdown. The cap is stated to the caller as `truncated`, never silently applied: a repository missing from a picker with no explanation is the same defect as a wrong one.
const MAX_PAGES_PER_INSTALLATION = 5;
const PER_PAGE = 100;

async function githubJson<T>(
  doFetch: typeof fetch,
  url: string,
  authorization: string,
): Promise<T | null> {
  const res = await doFetch(url, {
    headers: { authorization, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function reposForInstallation(
  doFetch: typeof fetch,
  token: string,
  installationId: number,
  account: string,
): Promise<{ repos: InstallationRepo[]; truncated: boolean }> {
  const repos: InstallationRepo[] = [];
  for (let page = 1; page <= MAX_PAGES_PER_INSTALLATION; page += 1) {
    const body = await githubJson<{
      total_count?: number;
      repositories?: Array<{ name?: string; full_name?: string; owner?: { login?: string } }>;
    }>(
      doFetch,
      `${GITHUB_API_BASE}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      `Bearer ${token}`,
    );
    const batch = body?.repositories ?? [];
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
}): Promise<{ repositories: InstallationRepo[]; truncated: boolean }> {
  const doFetch = args.fetchImpl ?? fetch;
  const jwt = buildAppJwt(args.appId, args.privateKey);

  const installations = await githubJson<Array<{ id?: number; account?: { login?: string } }>>(
    doFetch,
    `${GITHUB_API_BASE}/app/installations`,
    `Bearer ${jwt}`,
  );
  if (!installations) return { repositories: [], truncated: false };

  const out: InstallationRepo[] = [];
  let truncated = false;
  for (const inst of installations) {
    if (typeof inst.id !== 'number') continue;
    let token: string;
    try {
      token = await installationToken({
        appId: args.appId,
        privateKey: args.privateKey,
        installationId: inst.id,
        fetchImpl: doFetch,
      });
    } catch {
      // cm:why one installation the App can no longer mint for must not empty the whole picker — the operator may have revoked it on one account while another still works, and an empty dropdown reads as "no repositories" rather than "one account went away"
      continue;
    }
    const page = await reposForInstallation(doFetch, token, inst.id, inst.account?.login ?? '');
    out.push(...page.repos);
    truncated = truncated || page.truncated;
  }

  return { repositories: out, truncated };
}
