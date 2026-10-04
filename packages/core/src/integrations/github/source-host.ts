import { createHash } from 'node:crypto';
import type { HostCompare, SourceHost, SourceHostFactory } from '../source-host/index.js';
import {
  buildGitHubAgentClient,
  type GitHubAgentClient,
  githubAgentBindings,
} from './agent-client.js';
import {
  openPullRequest,
  readCheckRunLog,
  readPullRequestDiff,
  requestReview,
  submitReview,
  writePullRequestComment,
} from './agent-ops.js';
import { buildRepoClient, GitHubReadError, type GitHubRepoClient } from './client.js';
import { readLiveDivergence } from './live-divergence.js';
import { MERGE_METHODS, mergeGitHubPullRequest } from './merge.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const COMPARE_STATES: readonly HostCompare[] = ['ahead', 'behind', 'identical', 'diverged'];

/** The host a GitHub binding reaches: github.com, or the Enterprise host its API base names. */
export function githubHostOf(config: Record<string, unknown>): string {
  const api = typeof config.apiBaseUrl === 'string' ? config.apiBaseUrl : GITHUB_API_BASE;
  const host = new URL(api).host.toLowerCase();
  return host === 'api.github.com' ? 'github.com' : host;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * A file at a commit, read by the blob sha GitHub names — the contents API stops carrying bytes past
 * 1MB — and held to that sha before anyone hashes it for itself.
 */
async function readFileAt(
  client: GitHubRepoClient,
  path: string,
  ref: string,
  maxBytes: number,
): Promise<string | { missing: string }> {
  const repo = `/repos/${client.fullName}`;
  let entry: { type?: string; sha?: string; size?: number };
  try {
    entry = await client.get(`${repo}/contents/${encodePath(path)}?ref=${ref}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404)
      return { missing: `${path} does not exist at ${ref}` };
    throw err;
  }
  if (entry.type !== 'file' || !entry.sha)
    return { missing: `${path} at ${ref} is a ${entry.type ?? 'thing'} with no blob, not a file` };
  if ((entry.size ?? 0) > maxBytes)
    return {
      missing: `${path} at ${ref} is ${entry.size} bytes, over the ${maxBytes} an artifact may be`,
    };
  const blob = await client.get<{ content?: string; encoding?: string }>(
    `${repo}/git/blobs/${entry.sha}`,
  );
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`GitHub served blob ${entry.sha} with encoding ${blob.encoding ?? 'none'}`);
  }
  const bytes = Buffer.from(blob.content, 'base64');
  const git = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (git !== entry.sha)
    throw new Error(
      `blob ${entry.sha} hashed to ${git}; the bytes GitHub served are not the file it named`,
    );
  return bytes.toString('utf8');
}

/**
 * The GitHub host over one binding's repository client, with the agent client built only when an
 * agent verb asks — a kernel read never needs it.
 */
function githubSourceHostOf(
  client: GitHubRepoClient,
  agent: () => GitHubAgentClient,
  host = 'github.com',
): SourceHost {
  const repo = `/repos/${client.fullName}`;
  const compare = async (base: string, head: string): Promise<HostCompare> => {
    const cmp = await client.get<{ status?: string }>(
      `${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const status = COMPARE_STATES.find((s) => s === cmp.status);
    if (!status) {
      throw new GitHubReadError(
        200,
        `${client.fullName} compared ${base}...${head} as "${cmp.status ?? 'nothing'}"`,
      );
    }
    return status;
  };
  return {
    provider: 'github',
    bindingId: client.bindingId,
    fullName: client.fullName,
    host,
    words: { changeRequest: 'pull request', sigil: '#', mergeMethods: MERGE_METHODS },

    async readCommit(ref) {
      let read: { sha?: string; commit?: { message?: string; committer?: { date?: string } } };
      try {
        read = await client.get(`${repo}/commits/${encodeURIComponent(ref)}`);
      } catch (err) {
        const lookup =
          err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;
        if (lookup === 404 || lookup === 422) return null;
        throw err;
      }
      if (!read.sha)
        throw new GitHubReadError(200, `${client.fullName} answered no sha for ${ref}`);
      return {
        sha: read.sha.toLowerCase(),
        message: read.commit?.message ?? '',
        committedAt: read.commit?.committer?.date ?? null,
      };
    },
    async branchHead(branch) {
      const read = await client.get<{ commit?: { sha?: string } }>(
        `${repo}/branches/${encodeURIComponent(branch)}`,
      );
      const sha = read.commit?.sha;
      if (!sha)
        throw new GitHubReadError(200, `${client.fullName} answered no commit for ${branch}`);
      return sha;
    },
    compare,
    async branchContains(branch, sha) {
      const status = await compare(sha, branch);
      return status === 'ahead' || status === 'identical';
    },
    readDivergence: (refs) => readLiveDivergence(client, refs),
    readFile: (path, ref, maxBytes) => readFileAt(client, path, ref, maxBytes),

    diff: (args) => readPullRequestDiff(agent(), args),
    checkLog: (args) => readCheckRunLog(agent(), args),
    comment: (args) => writePullRequestComment(agent(), args),
    openChangeRequest: (args) => openPullRequest(agent(), args),
    requestReview: (args) => requestReview(agent(), args),
    submitReview: (args) => submitReview(agent(), args),
    merge: (args) => mergeGitHubPullRequest(client, args),
  };
}

export const githubSourceHost: SourceHostFactory = {
  label: 'GitHub',
  hostOf: githubHostOf,
  listBindings: async (projectId) =>
    (await githubAgentBindings(projectId)).map((r) => ({ provider: 'github', ...r })),
  build({ bindingId, config, secrets }) {
    const args = { bindingId, config: config as GitHubConfig, secrets: secrets as GitHubSecrets };
    const client = buildRepoClient(args);
    let agent: GitHubAgentClient | null = null;
    return githubSourceHostOf(
      client,
      () => {
        agent ??= buildGitHubAgentClient(args);
        return agent;
      },
      githubHostOf(config),
    );
  },
};
