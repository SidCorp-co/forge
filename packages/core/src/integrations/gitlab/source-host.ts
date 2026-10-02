import { createHash } from 'node:crypto';
import { SourceHostCallError } from '../source-host/errors.js';
import type {
  HostCompare,
  LiveDivergence,
  SourceHost,
  SourceHostFactory,
  WaitingCommit,
} from '../source-host/types.js';
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
}

const enc = encodeURIComponent;

function notFound(err: unknown): boolean {
  return err instanceof SourceHostCallError && err.phase === 'request' && err.status === 404;
}

/** The GitLab host over one binding's client. */
export function gitlabSourceHostOf(client: GitLabClient): SourceHost {
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

    async compare(base, head): Promise<HostCompare> {
      const [ahead, behind] = await Promise.all([
        commitsBetween(base, head),
        commitsBetween(head, base),
      ]);
      if (ahead.length === 0 && behind.length === 0) return 'identical';
      if (behind.length === 0) return 'ahead';
      if (ahead.length === 0) return 'behind';
      return 'diverged';
    },

    async branchContains(branch, sha) {
      const refs = await client.pages<{ type?: string; name?: string }>(
        client.project(`/repository/commits/${enc(sha)}/refs?type=branch`),
        REFS_MAX_PAGES,
      );
      return refs.some((r) => r.name === branch);
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
