import { createHash } from 'node:crypto';
import type {
  HostCommitFiles,
  HostCompare,
  HostFileChange,
  HostFileCompare,
  SourceHost,
  SourceHostFactory,
} from '../source-host/index.js';
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
import { readCompareCommits, readLiveDivergence } from './live-divergence.js';
import { MERGE_METHODS, mergeGitHubPullRequest } from './merge.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const COMPARE_STATES: readonly HostCompare[] = ['ahead', 'behind', 'identical', 'diverged'];

/** GitHub names at most this many files in one compare, and says nothing of the rest. */
const COMPARE_FILE_CEILING = 300;

interface CompareFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
}

/** What each file of a compare became; `filesOf` has already refused an entry with no name. */
function changesOf(files: CompareFile[]): HostFileChange[] {
  return files.flatMap((f): HostFileChange[] => {
    const path = f.filename as string;
    if (f.status === 'renamed' && f.previous_filename) {
      return [
        { path: f.previous_filename, change: 'removed' },
        { path, change: 'added' },
      ];
    }
    if (f.status === 'added' || f.status === 'copied') return [{ path, change: 'added' }];
    if (f.status === 'removed') return [{ path, change: 'removed' }];
    return [{ path, change: 'changed' }];
  });
}

/** Each file a compare names, a rename by both its names: the old path no longer holds it either.
 *  A reason where the list cannot be taken whole, since a missing list is not an empty one. */
function filesOf(files: CompareFile[] | undefined): string[] | string {
  if (!Array.isArray(files)) return 'the compare answered no file list';
  if (files.length >= COMPARE_FILE_CEILING) {
    return `${COMPARE_FILE_CEILING} or more files differ, and the repository names no more than that in one compare`;
  }
  const named = (p: unknown) => typeof p === 'string' && p !== '';
  const unnamed = files.some(
    (f) =>
      !named(f?.filename) || (f.previous_filename !== undefined && !named(f.previous_filename)),
  );
  if (unnamed) return 'the compare answered a file entry with no name';
  return files.flatMap((f) => [f.filename, f.previous_filename].filter(named) as string[]);
}

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
  const compareFiles = async (base: string, head: string): Promise<HostFileCompare> => {
    const read = await client.get<{ status?: string; files?: CompareFile[] }>(
      `${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const status = COMPARE_STATES.find((s) => s === read.status);
    if (!status) return { why: `${client.fullName} answered no compare status` };
    const files = filesOf(read.files);
    if (typeof files === 'string') return { why: files };
    return { status, files, changes: changesOf(read.files ?? []) };
  };
  const commitFiles = async (sha: string): Promise<HostCommitFiles> => {
    const commit = await client.get<{ parents?: Array<{ sha?: string }> }>(
      `${repo}/commits/${encodeURIComponent(sha)}`,
    );
    const parent = commit.parents?.[0]?.sha;
    if (!parent) return { why: `${sha} has no parent to diff it against` };
    const read = await compareFiles(parent, sha);
    return 'why' in read ? read : { files: read.files, changes: read.changes };
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
    compareFiles,
    commitFiles,
    async branchContains(branch, sha) {
      const status = await compare(sha, branch);
      return status === 'ahead' || status === 'identical';
    },
    readDivergence: (refs) => readLiveDivergence(client, refs),
    async readRange(base, head) {
      try {
        const { commits, aheadBy } = await readCompareCommits(client, base, head);
        return { ok: true, commits, complete: commits.length >= aheadBy };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
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
