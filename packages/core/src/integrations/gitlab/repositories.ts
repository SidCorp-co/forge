/**
 * The GitLab projects one connection's access token can push to.
 *
 * GitLab's counterpart of GitHub's installation repositories: a connection holds a token and a
 * base URL, and each project bound to it picks its repository from what that token reaches, never
 * from a path typed into a box. `membership=true&min_access_level=30` is "projects I am a member of
 * as Developer or above", the level a push and a merge request take; `simple=true` keeps each row to
 * the fields a picker reads.
 */

import { SourceHostCallError } from '../source-host/index.js';
import { GITLAB_DEFAULT_BASE_URL } from './types.js';

const REQUEST_TIMEOUT_MS = 12_000;
const PER_PAGE = 100;
const MAX_PAGES = 5;

/** One project the token reaches, as the picker shows it and a binding records it. */
export interface GitLabRepository {
  /** `group/sub/project`: what the binding stores as `projectPath`. */
  pathWithNamespace: string;
  /** GitLab's numeric id: what the binding stores as `projectId`. */
  id: number;
  defaultBranch: string | null;
  webUrl: string | null;
}

async function gitlabMessage(res: Response): Promise<string | null> {
  try {
    const parsed = (await res.json()) as { message?: unknown; error?: unknown };
    const said = parsed.message ?? parsed.error;
    if (said === undefined) return null;
    return (typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * Every project the token can push to on this instance, newest activity first, up to
 * {@link MAX_PAGES} pages; `search` narrows by name or path on GitLab's side. A refusal is thrown
 * with GitLab's own status and message, never read as an empty list.
 */
export async function listGitLabRepositories(args: {
  baseUrl: string | undefined;
  token: string;
  search?: string | undefined;
}): Promise<{ repositories: GitLabRepository[]; truncated: boolean; host: string }> {
  const base = (args.baseUrl ?? GITLAB_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const query = new URLSearchParams({
    membership: 'true',
    min_access_level: '30',
    simple: 'true',
    order_by: 'last_activity_at',
    per_page: String(PER_PAGE),
  });
  const search = args.search?.trim();
  if (search) query.set('search', search);

  const repositories: GitLabRepository[] = [];
  let page: string | null = '1';
  let read = 0;
  while (page && read < MAX_PAGES) {
    query.set('page', page);
    const path = `/projects?${query.toString()}`;
    const res = await fetch(`${base}/api/v4${path}`, {
      headers: { 'PRIVATE-TOKEN': args.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new SourceHostCallError(
        res.status,
        `GitLab at ${new URL(base).host} answered HTTP ${res.status} for its project list`,
        await gitlabMessage(res),
      );
    }
    const batch = (await res.json()) as Array<{
      id?: number;
      path_with_namespace?: string;
      default_branch?: string | null;
      web_url?: string;
    }>;
    for (const p of batch) {
      if (typeof p.id !== 'number' || !p.path_with_namespace) continue;
      repositories.push({
        pathWithNamespace: p.path_with_namespace,
        id: p.id,
        defaultBranch: p.default_branch ?? null,
        webUrl: p.web_url ?? null,
      });
    }
    read += 1;
    const next = res.headers.get('x-next-page');
    page = next && next.length > 0 ? next : null;
  }
  return { repositories, truncated: page !== null, host: new URL(base).host.toLowerCase() };
}
