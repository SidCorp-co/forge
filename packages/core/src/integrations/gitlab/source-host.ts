import { createHash } from 'node:crypto';
import type {
  HostCommitFiles,
  HostCompare,
  HostFileChange,
  HostFileCompare,
  LiveDivergence,
  SourceHost,
  SourceHostFactory,
  WaitingCommit,
} from '../source-host/index.js';
import { SourceHostCallError } from '../source-host/index.js';
import { gitlabAgentVerbs } from './agent-verbs.js';
import { buildGitLabClient, type GitLabClient } from './client.js';
import { GITLAB_MERGE_METHODS, mergeGitLabMergeRequest } from './merge.js';
import { gitlabBindingReports } from './report.js';
import { type GitLabConfig, type GitLabSecrets, gitlabHostOf } from './types.js';

const REFS_MAX_PAGES = 20;

interface CommitBody {
  id?: string;
  message?: string;
  committed_date?: string | null;
  parent_ids?: string[];
}

interface CompareBody {
  commits?: CommitBody[];
  diffs?: Array<{
    old_path?: string;
    new_path?: string;
    new_file?: boolean;
    deleted_file?: boolean;
    renamed_file?: boolean;
  }>;
}

const enc = encodeURIComponent;

function notFound(err: unknown): boolean {
  return err instanceof SourceHostCallError && err.phase === 'request' && err.status === 404;
}

/** The GitLab host over one binding's client. */
function gitlabSourceHostOf(client: GitLabClient): SourceHost {
  const commitsBetween = async (from: string, to: string): Promise<CommitBody[]> =>
    (
      await client.json<CompareBody>(
        'GET',
        client.project(`/repository/compare?from=${enc(from)}&to=${enc(to)}`),
      )
    ).commits ?? [];
  const branchHead = async (branch: string): Promise<string> => {
    const read = await client.json<{ commit?: { id?: string } }>(
      'GET',
      client.project(`/repository/branches/${enc(branch)}`),
    );
    const sha = read.commit?.id;
    if (!sha)
      throw new SourceHostCallError(200, `${client.fullName} answered no commit for ${branch}`);
    return sha;
  };

  const compare = async (base: string, head: string): Promise<HostCompare> => {
    const [ahead, behind] = await Promise.all([
      commitsBetween(base, head),
      commitsBetween(head, base),
    ]);
    if (ahead.length === 0 && behind.length === 0) return 'identical';
    if (behind.length === 0) return 'ahead';
    if (ahead.length === 0) return 'behind';
    return 'diverged';
  };
  const compareFiles = async (base: string, head: string): Promise<HostFileCompare> => {
    const [status, read] = await Promise.all([
      compare(base, head),
      client.json<CompareBody>(
        'GET',
        client.project(`/repository/compare?from=${enc(base)}&to=${enc(head)}`),
      ),
    ]);
    if (!Array.isArray(read.diffs)) return { why: `${client.fullName} answered no file list` };
    const named = (p: unknown): p is string => typeof p === 'string' && p !== '';
    if (read.diffs.some((d) => !named(d.new_path) || !named(d.old_path)))
      return { why: 'the compare answered a file entry with no name' };
    const changes = read.diffs.flatMap((d): HostFileChange[] => {
      const path = d.new_path as string;
      if (d.renamed_file) {
        return [
          { path: d.old_path as string, change: 'removed' },
          { path, change: 'added' },
        ];
      }
      if (d.new_file) return [{ path, change: 'added' }];
      if (d.deleted_file) return [{ path: d.old_path as string, change: 'removed' }];
      return [{ path, change: 'changed' }];
    });
    return {
      status,
      files: [...new Set(read.diffs.flatMap((d) => [d.new_path, d.old_path].filter(named)))],
      changes,
    };
  };

  return {
    provider: 'gitlab',
    bindingId: client.bindingId,
    fullName: client.fullName,
    host: client.host,
    words: { changeRequest: 'merge request', sigil: '!', mergeMethods: GITLAB_MERGE_METHODS },

    async readCommit(ref) {
      let read: CommitBody;
      try {
        read = await client.json<CommitBody>(
          'GET',
          client.project(`/repository/commits/${enc(ref)}`),
        );
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
      if (!read.id)
        throw new SourceHostCallError(200, `${client.fullName} answered no sha for ${ref}`);
      return {
        sha: read.id.toLowerCase(),
        message: read.message ?? '',
        committedAt: read.committed_date ?? null,
      };
    },

    branchHead,

    compare,

    compareFiles,

    async commitFiles(sha): Promise<HostCommitFiles> {
      const commit = await client.json<CommitBody>(
        'GET',
        client.project(`/repository/commits/${enc(sha)}`),
      );
      const parent = commit.parent_ids?.[0];
      if (!parent) return { why: `${sha} has no parent to diff it against` };
      const read = await compareFiles(parent, sha);
      return 'why' in read ? read : { files: read.files, changes: read.changes };
    },

    async branchContains(branch, sha) {
      const refs = await client.pages<{ type?: string; name?: string }>(
        client.project(`/repository/commits/${enc(sha)}/refs?type=branch`),
        REFS_MAX_PAGES,
      );
      return refs.some((r) => r.name === branch);
    },

    async readRange(base, head) {
      try {
        const commits: WaitingCommit[] = (await commitsBetween(base, head)).flatMap((c) =>
          c.id ? [{ sha: c.id, message: c.message ?? '', parents: c.parent_ids ?? [] }] : [],
        );
        return { ok: true, commits, complete: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async readDivergence(refs): Promise<LiveDivergence> {
      try {
        const [baseSha, liveSha] = await Promise.all([
          branchHead(refs.baseRef),
          branchHead(refs.liveRef),
        ]);
        const commits: WaitingCommit[] = (await commitsBetween(liveSha, baseSha)).flatMap((c) =>
          c.id ? [{ sha: c.id, message: c.message ?? '', parents: c.parent_ids ?? [] }] : [],
        );
        return { ok: true, baseSha, liveSha, aheadBy: commits.length, commits, complete: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async readFile(path, ref, maxBytes) {
      let file: { size?: number; encoding?: string; content?: string; blob_id?: string };
      try {
        file = await client.json(
          'GET',
          client.project(`/repository/files/${enc(path)}?ref=${enc(ref)}`),
        );
      } catch (err) {
        if (notFound(err)) return { missing: `${path} does not exist at ${ref}` };
        throw err;
      }
      if ((file.size ?? 0) > maxBytes) {
        return {
          missing: `${path} at ${ref} is ${file.size} bytes, over the ${maxBytes} an artifact may be`,
        };
      }
      if (file.encoding !== 'base64' || typeof file.content !== 'string' || !file.blob_id) {
        throw new Error(
          `GitLab served ${path} at ${ref} with encoding ${file.encoding ?? 'none'} and blob ${file.blob_id ?? 'none'}`,
        );
      }
      const bytes = Buffer.from(file.content, 'base64');
      const git = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (git !== file.blob_id) {
        throw new Error(
          `blob ${file.blob_id} hashed to ${git}; the bytes GitLab served are not the file it named`,
        );
      }
      return bytes.toString('utf8');
    },

    ...gitlabAgentVerbs(client, branchHead),
    merge: (args) => mergeGitLabMergeRequest(client, args),
  };
}

export const gitlabSourceHost: SourceHostFactory = {
  label: 'GitLab',
  hostOf: gitlabHostOf,
  build: ({ bindingId, config, secrets }) =>
    gitlabSourceHostOf(
      buildGitLabClient({
        bindingId,
        config: config as GitLabConfig,
        secrets: secrets as GitLabSecrets,
      }),
    ),
  listBindings: gitlabBindingReports,
};
