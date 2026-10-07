import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PinnedSshHost } from './ssh-host-guard.js';

/** Where in Forge a project's deploy key is attached, for a sentence telling an operator to fix it. */
export const GIT_ACCESS = "the project's Settings → Runners → Git access";

/**
 * What one fetch may spend before it is stopped and the reading refused. The byte budget is what
 * bounds a host that ignores a `--filter` and sends every file: the filter is a request, not a
 * guarantee. It is enforced by the kernel (`ulimit -f`) on every file the fetch writes, at a fifth
 * of the budget: the fetch keeps what it receives as one pack, and the only other files that grow
 * with it are the pack's index (at most 36 bytes per object, an object taking at least 10 in the
 * pack, so under four packs' worth) and its reverse index (4 bytes per object), so the files
 * together stay within the budget with no write landing between two checks.
 */
export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
}

export const REMOTE_FETCH_LIMITS: FetchLimits = { timeoutMs: 60_000, maxBytes: 256 * 1024 * 1024 };

/** The pack, its index and its reverse index share the budget; each file may take this fraction. */
const PER_FILE_SHARE = 5;

export class GitRefusal extends Error {}

export interface GitFailure {
  stderr?: string | Buffer;
  code?: number | string | null;
}

export function firstLine(s: string): string {
  const line = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, 300);
}

/** No user or system config, no prompt, and no object fetched behind the reading's back. */
export function readingEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** What a failed fetch means to an operator, in the words of the thing that failed. */
export function fetchRefusal(err: GitFailure): string {
  const stderr = (err.stderr ?? '').toString();
  const missing = stderr.match(/couldn't find remote ref (?:refs\/heads\/)?(\S+)/i);
  if (missing?.[1]) return `the repository has no branch ${missing[1]}, so it cannot be compared`;
  if (/permission denied|access denied|not authori[sz]ed/i.test(stderr)) {
    return `the git host refused the deploy key attached to this project (${firstLine(stderr)}) — give its public key read access to the repository; the key is the one attached under ${GIT_ACCESS}`;
  }
  return `the git host answered the fetch with: ${firstLine(stderr) || `git exited ${String(err.code ?? 'abnormally')}`}`;
}

/** git names the address ssh was pinned to; an operator knows the repository by its URL's host. */
export function namingTheHost(reason: string, pin: PinnedSshHost): string {
  return pin.address === pin.host ? reason : reason.replaceAll(pin.address, pin.host);
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

/** A fetch that failed, read by `refusal` from its stderr unless it passed the byte budget. */
export interface BoundedFetch {
  /** What the fetch was doing, as a sentence opens: "fetching main from the git host". */
  what: string;
  /** The repository the fetch writes into, measured when it fails. */
  repo: string;
  /** The filter the host was asked for, as an operator reads it: "commits-only". */
  filter: string;
  refusal?: (err: GitFailure) => string;
}

/** `git <args>` in a process group of its own under `ulimit -f`, killed whole past the time budget. */
export function boundedFetch(
  args: string[],
  env: NodeJS.ProcessEnv,
  fetch: BoundedFetch,
  limits: FetchLimits,
): Promise<void> {
  const { what, repo, filter } = fetch;
  const overBudget = `${what} passed ${Math.round(limits.maxBytes / 1024)} KiB, the most one reading may fetch — the host may not honour the ${filter} filter`;
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
        reject(
          new GitRefusal(
            n >= blocks * 512 ? overBudget : (fetch.refusal ?? fetchRefusal)({ stderr, code }),
          ),
        ),
      );
    });
  });
}
