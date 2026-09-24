import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LiveDivergence, WaitingCommit } from '../integrations/github/live-divergence.js';
import { withDeployKey } from './ssh-keys.js';

const execFileAsync = promisify(execFile);

/** Waiting commits listed per reading. A longer wait than this is reported as cut short. */
export const REMOTE_MAX_COMMITS = 1000;
/** How long the fetch of both branches may take before the reading is refused. */
export const REMOTE_FETCH_TIMEOUT_MS = 60_000;

const RECORD = '\x1e';
const FIELD = '\x00';

export interface BranchRefs {
  baseRef: string;
  liveRef: string;
}

class GitRefusal extends Error {}

interface GitFailure {
  stderr?: string | Buffer;
  killed?: boolean;
  signal?: string;
  code?: number | string;
}

function firstLine(s: string): string {
  const line = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, 300);
}

/** What a failed fetch means to an operator, in the words of the thing that failed. */
function fetchRefusal(err: GitFailure, refs: BranchRefs): string {
  if (err.killed || err.signal === 'SIGTERM') {
    return `fetching ${refs.baseRef} and ${refs.liveRef} from the git host took longer than ${REMOTE_FETCH_TIMEOUT_MS / 1000}s`;
  }
  const stderr = (err.stderr ?? '').toString();
  const missing = stderr.match(/couldn't find remote ref (?:refs\/heads\/)?(\S+)/i);
  if (missing?.[1]) return `the repository has no branch ${missing[1]}, so it cannot be compared`;
  if (/permission denied|access denied|not authori[sz]ed/i.test(stderr)) {
    return `the git host refused the deploy key attached to this project (${firstLine(stderr)}) — give its public key read access to the repository`;
  }
  return `the git host answered the fetch with: ${firstLine(stderr) || `git exited ${String(err.code ?? 'abnormally')}`}`;
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
): Promise<LiveDivergence> {
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const repo = join(dir, 'live-reading.git');
  const git = async (args: string[], timeout = 20_000): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      env: gitEnv,
      timeout,
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
    await git(
      [
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
      REMOTE_FETCH_TIMEOUT_MS,
    ).catch((err: GitFailure) => {
      throw new GitRefusal(fetchRefusal(err, refs));
    });
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
      `--max-count=${REMOTE_MAX_COMMITS}`,
      '--format=%H%x00%B%x1e',
      range,
    ]);
    const commits: WaitingCommit[] = [];
    for (const entry of log.split(RECORD)) {
      const at = entry.indexOf(FIELD);
      if (at < 0) continue;
      commits.push({ sha: entry.slice(0, at).trim(), message: entry.slice(at + 1).trim() });
    }
    return { ok: true, baseSha, liveSha, aheadBy, commits, complete: commits.length >= aheadBy };
  } catch (err) {
    if (err instanceof GitRefusal) return { ok: false, reason: err.message };
    const e = err as GitFailure;
    return {
      ok: false,
      reason: `reading the fetched branches failed: ${firstLine((e.stderr ?? '').toString()) || (err instanceof Error ? err.message : String(err))}`,
    };
  }
}

/** The same reading over SSH, as the project's deploy key and nothing else. */
export async function readRemoteDivergence(
  source: { repoUrl: string; privateKey: string },
  refs: BranchRefs,
): Promise<LiveDivergence> {
  return withDeployKey(source.privateKey, (env, dir) =>
    fetchDivergence(source.repoUrl, env, refs, dir),
  );
}
