import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Refused, saying } from '../projects/repository-reader.js';
import type { PinnedSshHost } from './ssh-host-guard.js';

/** Where in Forge a project's deploy key is attached, for a sentence telling an operator to fix it. */
export const GIT_ACCESS = "the project's Settings → Runners → Git access";

/**
 * What every sentence asks the git host to give the key attached under Git access, and why. Write,
 * not read: core only reads with it, but it is the key the project's runner is provisioned with and
 * pushes with, so a key given read alone clears a read and breaks the next push.
 */
export const KEY_ACCESS = 'write access';
export const WHY_KEY_ACCESS =
  "since Forge reads the repository with it and the project's runner pushes with it";

/** The host a remote names, for a sentence; the URL itself where no host can be read from it. */
export function hostOf(repoUrl: string): string {
  const u = repoUrl.trim();
  try {
    if (u.includes('://')) return new URL(u).hostname || u;
  } catch {
    return u;
  }
  return u.match(/^[^@\s]+@([^:\s/]+):/)?.[1] ?? u;
}

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

/** A git read that failed, its cause and the act that clears it held apart (`refused`). */
export class GitRefusal extends Error {
  readonly refused: Refused;

  constructor(said: string | Refused) {
    const refused = typeof said === 'string' ? { cause: said } : said;
    super(saying(refused));
    this.refused = refused;
  }
}

export interface GitFailure {
  stderr?: string | Buffer;
  code?: number | string | null;
}

const GIT_TRAILER =
  /^(fatal: could not read from remote repository\.?|please make sure you have the correct access rights|and the repository exists\.?)$/i;

const RULE = /^[=\-*#_~]{3,}$/;

/** The first line a git host said with words in it, past git's `remote:` prefix, banner rules
 *  (GitLab opens a refusal with them) and git's own trailer, which is kept only where alone. */
export function hostSaid(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^remote:/i, '').trim())
    .filter((l) => l !== '' && !RULE.test(l));
  return (lines.find((l) => !GIT_TRAILER.test(l)) ?? lines[0] ?? '').slice(0, 300);
}

const KEY_REFUSED =
  /permission denied \(|no supported authentication methods|too many authentication failures/i;

/** The host took the key and will not serve this path: GitLab, GitHub, a plain server, in turn. */
const NO_ACCESS =
  /you don't have permission to view it|repository not found|does not appear to be a git repository|\bdoes not exist\b|access denied|not authori[sz]ed|forbidden|permission denied/i;

const UNREACHABLE =
  /could not resolve hostname|connection timed out|connection refused|no route to host|network is unreachable|operation timed out|name or service not known|temporary failure in name resolution/i;

export type HostRefusal =
  | { kind: 'no_branch'; branch: string; said: string }
  | { kind: 'key_refused' | 'no_access' | 'unreachable' | 'other'; said: string };

export function readHostRefusal(stderr: string): HostRefusal {
  const said = hostSaid(stderr);
  const missing = stderr.match(/couldn't find remote ref (?:refs\/heads\/)?(\S+)/i);
  if (missing?.[1]) return { kind: 'no_branch', branch: missing[1], said };
  if (KEY_REFUSED.test(stderr)) return { kind: 'key_refused', said };
  if (NO_ACCESS.test(stderr)) return { kind: 'no_access', said };
  if (UNREACHABLE.test(stderr)) return { kind: 'unreachable', said };
  return { kind: 'other', said };
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

/** What a failed fetch of `remote` means to an operator: its cause, in the host's words, and apart
 *  from it the act that clears it, so a sentence naming several causes gives that act once. */
export function hostRefusal(err: GitFailure, remote: string): Refused {
  const answer = readHostRefusal((err.stderr ?? '').toString());
  const { said } = answer;
  switch (answer.kind) {
    case 'no_branch':
      return { cause: `the repository has no branch ${answer.branch}, so it cannot be compared` };
    case 'key_refused':
      return {
        cause: `the git host refused the deploy key attached to this project (${said})`,
        clears: `give its public key ${KEY_ACCESS} to ${remote}, ${WHY_KEY_ACCESS}; the key is the one attached under ${GIT_ACCESS}`,
      };
    case 'no_access':
      return {
        cause: `the git host took the deploy key attached to this project but will not let it read ${remote} (${said})`,
        clears: `on the git host, give the deploy key attached under ${GIT_ACCESS} ${KEY_ACCESS} to that repository, ${WHY_KEY_ACCESS}; if no repository lives at that URL, correct the SSH clone URL set there`,
      };
    case 'unreachable':
      return {
        cause: `the git host ${hostOf(remote)} could not be reached (${said}), so the deploy key was never offered`,
        clears: `check that the SSH clone URL ${remote}, set under ${GIT_ACCESS}, names the right host and that the host is up`,
      };
    default:
      return {
        cause: `the git host answered the fetch with: ${said || `git exited ${String(err.code ?? 'abnormally')}`}`,
      };
  }
}

export function fetchRefusal(err: GitFailure, remote: string): string {
  return saying(hostRefusal(err, remote));
}

/** git names the address ssh was pinned to; an operator knows the repository by its URL's host. */
export function namingTheHost(reason: string, pin: PinnedSshHost): string {
  return pin.address === pin.host ? reason : reason.replaceAll(pin.address, pin.host);
}

export function refusedNamingTheHost(refused: Refused, pin: PinnedSshHost): Refused {
  const cause = namingTheHost(refused.cause, pin);
  return refused.clears === undefined
    ? { cause }
    : { cause, clears: namingTheHost(refused.clears, pin) };
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
  /** The URL fetched from, as a refusal names the repository to give the key access to. */
  remote: string;
  /** The repository the fetch writes into, measured when it fails. */
  repo: string;
  /** The filter the host was asked for, as an operator reads it: "commits-only". */
  filter: string;
  refusal?: (err: GitFailure) => string | Refused;
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
            n >= blocks * 512
              ? overBudget
              : (fetch.refusal ?? ((e) => hostRefusal(e, fetch.remote)))({ stderr, code }),
          ),
        ),
      );
    });
  });
}
