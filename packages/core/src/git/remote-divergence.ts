import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import type { LiveDivergence, WaitingCommit } from '../integrations/github/live-divergence.js';
import {
  boundedFetch,
  type FetchLimits,
  type GitFailure,
  GitRefusal,
  hostSaid,
  namingTheHost,
  REMOTE_FETCH_LIMITS,
  readingEnv,
} from './bounded-fetch.js';
import { withDeployKey } from './ssh-keys.js';

const execFileAsync = promisify(execFile);

/** Waiting commits listed per reading. A longer wait than this is reported as cut short. */
export const REMOTE_MAX_COMMITS = 1000;

export interface BranchRefs {
  baseRef: string;
  liveRef: string;
}

/**
 * The commits on `refs.baseRef` that `refs.liveRef` does not contain, read from `remote` into a
 * bare repository under `dir`. Only commits are fetched (`--filter=tree:0`) and nothing is fetched
 * lazily afterwards, so a reading costs the branches' history and no file contents.
 */
export async function fetchDivergence(
  remote: string,
  env: NodeJS.ProcessEnv,
  refs: BranchRefs,
  dir: string,
  limits: FetchLimits = REMOTE_FETCH_LIMITS,
): Promise<LiveDivergence> {
  const gitEnv = readingEnv(env);
  const repo = join(dir, 'live-reading.git');
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      env: gitEnv,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  };
  try {
    for (const branch of [refs.baseRef, refs.liveRef]) {
      await git(['check-ref-format', `refs/heads/${branch}`]).catch(() => {
        throw new GitRefusal(`${branch} is not a branch name git accepts, so it cannot be fetched`);
      });
    }
    await git(['init', '--bare', '--quiet', repo]);
    await boundedFetch(
      [
        '-c',
        'fetch.unpackLimit=1',
        '-C',
        repo,
        'fetch',
        '--quiet',
        '--no-tags',
        '--filter=tree:0',
        remote,
        `+refs/heads/${refs.baseRef}:refs/forge/base`,
        `+refs/heads/${refs.liveRef}:refs/forge/live`,
      ],
      gitEnv,
      {
        what: `fetching ${refs.baseRef} and ${refs.liveRef} from the git host`,
        remote,
        repo,
        filter: 'commits-only',
      },
      limits,
    );
    const [baseSha = '', liveSha = ''] = (
      await git(['-C', repo, 'rev-parse', 'refs/forge/base', 'refs/forge/live'])
    )
      .trim()
      .split('\n');
    const range = 'refs/forge/live..refs/forge/base';
    const aheadBy = Number((await git(['-C', repo, 'rev-list', '--count', range])).trim());
    const log = await git([
      '-C',
      repo,
      'log',
      '-z',
      `--max-count=${REMOTE_MAX_COMMITS}`,
      '--format=%H %P%n%B',
      range,
    ]);
    const commits: WaitingCommit[] = [];
    for (const entry of log.split('\0')) {
      const at = entry.indexOf('\n');
      if (at < 0) continue;
      const message = entry.slice(at + 1);
      const [sha = '', ...parents] = entry.slice(0, at).trim().split(' ');
      commits.push({
        sha,
        message: message.endsWith('\n') ? message.slice(0, -1) : message,
        parents,
      });
    }
    return { ok: true, baseSha, liveSha, aheadBy, commits, complete: commits.length >= aheadBy };
  } catch (err) {
    if (err instanceof GitRefusal) return { ok: false, reason: err.message };
    const e = err as GitFailure;
    return {
      ok: false,
      reason: `reading the fetched branches failed: ${hostSaid((e.stderr ?? '').toString()) || (err instanceof Error ? err.message : String(err))}`,
    };
  }
}

/** The same reading over SSH, as the project's deploy key and nothing else. */
export async function readRemoteDivergence(
  source: { repoUrl: string; privateKey: string },
  refs: BranchRefs,
): Promise<LiveDivergence> {
  return withDeployKey(
    source.privateKey,
    source.repoUrl,
    async (env, dir, pin): Promise<LiveDivergence> => {
      const d = await fetchDivergence(source.repoUrl, env, refs, dir);
      return d.ok ? d : { ok: false, reason: namingTheHost(d.reason, pin) };
    },
  ).catch((err: unknown): LiveDivergence => {
    if (!(err instanceof HTTPException)) throw err;
    return { ok: false, reason: `${source.repoUrl} cannot be read: ${err.message}` };
  });
}
