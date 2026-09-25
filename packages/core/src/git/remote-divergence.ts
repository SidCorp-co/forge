import { execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import type { LiveDivergence, WaitingCommit } from '../integrations/github/live-divergence.js';
import type { PinnedSshHost } from './ssh-host-guard.js';
import { withDeployKey } from './ssh-keys.js';

const execFileAsync = promisify(execFile);

/** Where in Forge a project's deploy key is attached, for a sentence telling an operator to fix it. */
export const GIT_ACCESS = "the project's Settings → Runners → Git access";

/** Waiting commits listed per reading. A longer wait than this is reported as cut short. */
export const REMOTE_MAX_COMMITS = 1000;

/**
 * What one fetch may spend before it is stopped and the reading refused. The byte budget is what
 * bounds a host that ignores `--filter=tree:0` and sends every file: the filter is a request, not a
 * guarantee, and the commit-list bound says nothing about what the fetch transferred to get there.
 * It is enforced by the kernel (`ulimit -f`) on every file the fetch writes, at a fifth of the
 * budget: the fetch keeps what it receives as one pack, and the only other files that grow with it
 * are the pack's index (at most 36 bytes per object, an object taking at least 10 in the pack, so
 * under four packs' worth) and its reverse index (4 bytes per object), so the files together stay
 * within the budget with no write landing between two checks.
 */
export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
}

export const REMOTE_FETCH_LIMITS: FetchLimits = { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024 };

/** The pack, its index and its reverse index share the budget; each file may take this fraction. */
const PER_FILE_SHARE = 5;

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
    return `the git host refused the deploy key attached to this project (${firstLine(stderr)}) — give its public key read access to the repository; the key is the one attached under ${GIT_ACCESS}`;
  }
  return `the git host answered the fetch with: ${firstLine(stderr) || `git exited ${String(err.code ?? 'abnormally')}`}`;
}

async function largestFile(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  let largest = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    largest = Math.max(
      largest,
      (await stat(join(e.parentPath, e.name)).catch(() => null))?.size ?? 0,
    );
  }
  return largest;
}

/**
 * Run the fetch in a process group of its own under a file-size limit, so the ssh it starts is
 * stopped with it and no file it writes passes the byte budget, and kill the group the moment it
 * outlives the time budget.
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
  const blocks = Math.max(1, Math.floor(limits.maxBytes / PER_FILE_SHARE / 512));
  return new Promise((resolve, reject) => {
    const child = spawn(
      'sh',
      ['-c', 'ulimit -f "$1" && shift && exec git "$@"', 'sh', String(blocks), ...args],
      { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
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
    const done = () => clearTimeout(timer);
    child.on('error', (err) => {
      done();
      reject(new GitRefusal(`git could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      done();
      if (stopped) return reject(new GitRefusal(stopped));
      if (code === 0) return resolve();
      void largestFile(repo).then((n) =>
        reject(new GitRefusal(n >= blocks * 512 ? overBudget : fetchRefusal({ stderr, code }))),
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
      '-z',
      `--max-count=${REMOTE_MAX_COMMITS}`,
      '--format=%H%n%B',
      range,
    ]);
    const commits: WaitingCommit[] = [];
    for (const entry of log.split('\0')) {
      const at = entry.indexOf('\n');
      if (at < 0) continue;
      const message = entry.slice(at + 1);
      commits.push({
        sha: entry.slice(0, at),
        message: message.endsWith('\n') ? message.slice(0, -1) : message,
      });
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

/**
 * ssh writes `user@<HostName>`, and the connection is pinned to an address, so git's own words name
 * that address; an operator knows the repository by the host its URL names.
 */
function namingTheHost(reason: string, pin: PinnedSshHost): string {
  return pin.address === pin.host ? reason : reason.replaceAll(pin.address, pin.host);
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
