import { execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LiveDivergence, WaitingCommit } from '../integrations/github/live-divergence.js';
import { withDeployKey } from './ssh-keys.js';

const execFileAsync = promisify(execFile);

/** Waiting commits listed per reading. A longer wait than this is reported as cut short. */
export const REMOTE_MAX_COMMITS = 1000;

/**
 * What one fetch may spend before it is stopped and the reading refused. The byte budget is what
 * bounds a host that ignores `--filter=tree:0` and sends every file: the filter is a request, not a
 * guarantee, and the commit-list bound says nothing about what the fetch transferred to get there.
 */
export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
}

export const REMOTE_FETCH_LIMITS: FetchLimits = { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024 };

const RECORD = '\x1e';
const FIELD = '\x00';

export interface BranchRefs {
  baseRef: string;
  liveRef: string;
}

class GitRefusal extends Error {}

interface GitFailure {
  stderr?: string | Buffer;
  code?: number | string | null;
}

function firstLine(s: string): string {
  const line = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, 300);
}

/** What a failed fetch means to an operator, in the words of the thing that failed. */
function fetchRefusal(err: GitFailure): string {
  const stderr = (err.stderr ?? '').toString();
  const missing = stderr.match(/couldn't find remote ref (?:refs\/heads\/)?(\S+)/i);
  if (missing?.[1]) return `the repository has no branch ${missing[1]}, so it cannot be compared`;
  if (/permission denied|access denied|not authori[sz]ed/i.test(stderr)) {
    return `the git host refused the deploy key attached to this project (${firstLine(stderr)}) — give its public key read access to the repository`;
  }
  return `the git host answered the fetch with: ${firstLine(stderr) || `git exited ${String(err.code ?? 'abnormally')}`}`;
}

async function bytesUnder(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    total += (await stat(join(e.parentPath, e.name)).catch(() => null))?.size ?? 0;
  }
  return total;
}

/**
 * Run the fetch in a process group of its own, so the ssh it starts is stopped with it, and stop
 * the group the moment it outlives the time budget or the repository outgrows the byte budget.
 */
function boundedFetch(
  args: string[],
  env: NodeJS.ProcessEnv,
  repo: string,
  refs: BranchRefs,
  limits: FetchLimits,
): Promise<void> {
  const what = `fetching ${refs.baseRef} and ${refs.liveRef} from the git host`;
  const overBudget = `${what} passed ${Math.round(limits.maxBytes / 1024)} KiB, the most one reading may fetch — the host may not honour the commits-only filter`;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let stopped: string | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString();
    });
    const stop = (why: string) => {
      if (stopped) return;
      stopped = why;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(
      () => stop(`${what} took longer than ${limits.timeoutMs / 1000}s`),
      limits.timeoutMs,
    );
    const watch = setInterval(() => {
      void bytesUnder(repo).then((n) => {
        if (n > limits.maxBytes) stop(overBudget);
      });
    }, 250);
    const done = () => {
      clearTimeout(timer);
      clearInterval(watch);
    };
    child.on('error', (err) => {
      done();
      reject(new GitRefusal(`git could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      done();
      if (stopped) return reject(new GitRefusal(stopped));
      if (code !== 0) return reject(new GitRefusal(fetchRefusal({ stderr, code })));
      void bytesUnder(repo).then((n) =>
        n > limits.maxBytes ? reject(new GitRefusal(overBudget)) : resolve(),
      );
    });
  });
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
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
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
      repo,
      refs,
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
