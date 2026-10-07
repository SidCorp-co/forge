/**
 * The repository reads Forge takes with plain git, as the project's deploy key (ISS-1398): what a
 * project hosted anywhere but GitHub — or bound to nothing — is read through. One reading owns two
 * bare repositories under the deploy key's temp dir and fetches into them only what a question
 * needs: every branch's commits once (`--filter=tree:0`), for which commit a name is, its message
 * and parents, and which branch holds it; and, for a question about files, the trees of just the
 * commits it compares (`--depth=1 --filter=blob:none`), never a file's contents. Nothing is fetched
 * lazily behind a read, and every fetch is held to `REMOTE_FETCH_LIMITS`.
 *
 * Every read that fails answers with the reason, in git's words with the pinned address put back
 * to the host the URL names; none is ever read as "contains".
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type BranchRead,
  type Carriage,
  type ChangedPaths,
  type CommitLookup,
  type Containment,
  type FoundCommit,
  RANGE_COMMIT_LIMIT,
  type RangeCommit,
  type RangeRead,
  type Refused,
  type RepositoryReader,
  saying,
} from '../projects/repository-reader.js';
import {
  boundedFetch,
  type FetchLimits,
  type GitFailure,
  GitRefusal,
  hostRefusal,
  hostSaid,
  REMOTE_FETCH_LIMITS,
  readingEnv,
  refusedNamingTheHost,
} from './bounded-fetch.js';
import type { PinnedSshHost } from './ssh-host-guard.js';

const execFileAsync = promisify(execFile);

/** A whole sha is SHA-1's 40 digits or SHA-256's 64; a name of any other length is a prefix. */
const isWholeSha = (ref: string) => ref.length === 40 || ref.length === 64;

const COMMIT_NAME = /^[0-9a-f]{4,64}$/i;

/** What the host says when asked for a commit no ref it serves reaches. */
const UNREACHABLE = /not our ref|no such remote ref|couldn't find remote ref|unadvertised object/i;

/** The sentinel the sha fetch's refusal returns for an absent commit; never shown to anyone. */
const ABSENT = '\u0000absent';

type Resolved =
  | { ok: true; commit: FoundCommit }
  | { ok: false; lookup: CommitLookup; why: string };

function splitEntry(entry: string): RangeCommit | null {
  const at = entry.indexOf('\n');
  if (at < 0) return null;
  const message = entry.slice(at + 1);
  const [sha = '', ...parents] = entry.slice(0, at).trim().split(' ');
  if (!sha) return null;
  return { sha, parents, message: message.endsWith('\n') ? message.slice(0, -1) : message };
}

/** One reading: the two bare repositories, what has been fetched into them, and git run on them. */
class GitReading {
  readonly history: string;
  private readonly trees: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly limits: FetchLimits;
  private historyRead: Promise<void> | null = null;
  private treesRead: Promise<void> = Promise.resolve();
  private treesMade = false;
  private readonly fetched = new Set<string>();

  constructor(
    readonly remote: string,
    env: NodeJS.ProcessEnv,
    dir: string,
    private readonly opts: { pin?: PinnedSshHost; limits?: FetchLimits },
  ) {
    this.env = readingEnv(env);
    this.limits = opts.limits ?? REMOTE_FETCH_LIMITS;
    this.history = join(dir, 'history.git');
    this.trees = join(dir, 'trees.git');
  }

  async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      env: this.env,
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** Exit status of a git command whose answer is its status: 0, 1, or a failure thrown. */
  async status(args: string[]): Promise<number> {
    try {
      await this.git(args);
      return 0;
    } catch (err) {
      if ((err as GitFailure).code === 1) return 1;
      throw err;
    }
  }

  private fetchInto(repo: string, what: string, filter: string, args: string[]): Promise<void> {
    return boundedFetch(
      ['-c', 'fetch.unpackLimit=1', '-C', repo, 'fetch', '--quiet', '--no-tags', ...args],
      this.env,
      { what, remote: this.remote, repo, filter },
      this.limits,
    );
  }

  private ensureHistory(): Promise<void> {
    this.historyRead ??= (async () => {
      await this.git(['init', '--bare', '--quiet', this.history]);
      await this.fetchInto(
        this.history,
        "fetching every branch's commits from the git host",
        'commits-only',
        ['--filter=tree:0', this.remote, '+refs/heads/*:refs/forge/heads/*'],
      );
    })();
    return this.historyRead;
  }

  private async verified(name: string): Promise<string | null> {
    try {
      const out = await this.git(['-C', this.history, 'rev-parse', '--verify', '--quiet', name]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /** Fetch one full sha no branch reaches; false where the host serves no such commit. */
  private async fetchSha(sha: string): Promise<boolean> {
    try {
      await boundedFetch(
        ['-C', this.history, 'fetch', '--quiet', '--no-tags', '--filter=tree:0', this.remote, sha],
        this.env,
        {
          what: `fetching commit ${sha} from the git host`,
          remote: this.remote,
          repo: this.history,
          filter: 'commits-only',
          refusal: (err) =>
            UNREACHABLE.test((err.stderr ?? '').toString())
              ? ABSENT
              : hostRefusal(err, this.remote),
        },
        this.limits,
      );
      return true;
    } catch (err) {
      if (err instanceof GitRefusal && err.message === ABSENT) return false;
      throw err;
    }
  }

  /** That the repository holds no commit under `ref`, as a fact. */
  private unheld(ref: string): string {
    return isWholeSha(ref)
      ? `${this.remote} holds no commit ${ref}`
      : `${this.remote} resolves no single commit from ${ref}: no commit on any of its branches ` +
          'starts with it, or more than one does';
  }

  private absent(ref: string): Resolved {
    const ask = isWholeSha(ref)
      ? 'Mark with the sha the work landed at'
      : 'Mark with the full 40-character sha the work landed at';
    return {
      ok: false,
      why: this.unheld(ref),
      lookup: {
        kind: 'absent',
        detail: `${this.unheld(ref)}. ${ask}`,
        details: { commit: ref, repository: this.remote },
      },
    };
  }

  /** The commit `ref` names, read whole: its full sha, parents, committer date and message. */
  async resolve(ref: string): Promise<Resolved> {
    const name = ref.trim().toLowerCase();
    if (!COMMIT_NAME.test(name)) return this.absent(ref);
    await this.ensureHistory();
    let sha = await this.verified(`${name}^{commit}`);
    if (!sha && isWholeSha(name) && (await this.fetchSha(name))) {
      sha = await this.verified(`${name}^{commit}`);
    }
    if (!sha) return this.absent(ref);
    // `log`, not `show`: `show -s` still reads the tree, which this reading never fetched.
    const shown = await this.git([
      '-C',
      this.history,
      'log',
      '-1',
      '-z',
      '--no-walk',
      '--format=%H%x00%P%x00%cI%x00%B',
      sha,
    ]);
    const [full = '', parents = '', date = '', ...body] = shown.replace(/\0$/, '').split('\0');
    const message = body.join('\0');
    return {
      ok: true,
      commit: {
        sha: full.trim().toLowerCase(),
        parents: parents.trim() ? parents.trim().split(' ') : [],
        committedAt: date.trim() || null,
        message: message.endsWith('\n') ? message.slice(0, -1) : message,
      },
    };
  }

  async head(branch: string): Promise<BranchRead> {
    try {
      await this.git(['check-ref-format', `refs/heads/${branch}`]);
    } catch {
      return { why: `${branch} is not a branch name git accepts, so it cannot be read` };
    }
    await this.ensureHistory();
    const sha = await this.verified(`refs/forge/heads/${branch}`);
    return sha ? { sha } : { why: `${this.remote} has no branch ${branch}`, missingBranch: branch };
  }

  /** The trees of `shas`, fetched one pass at a time into the shallow repository. */
  private ensureTrees(shas: string[]): Promise<void> {
    this.treesRead = this.treesRead.then(async () => {
      const missing = [...new Set(shas)].filter((s) => !this.fetched.has(s));
      if (missing.length === 0) return;
      if (!this.treesMade) {
        await this.git(['init', '--bare', '--quiet', this.trees]);
        this.treesMade = true;
      }
      await this.fetchInto(
        this.trees,
        `fetching the trees of ${missing.length} commit(s) from the git host`,
        'no-file-contents',
        ['--depth=1', '--filter=blob:none', this.remote, ...missing],
      );
      for (const s of missing) this.fetched.add(s);
    });
    return this.treesRead;
  }

  /** Every file `from` and `to` differ in, a rename by both its names. */
  async differ(from: string, to: string): Promise<string[]> {
    await this.ensureTrees([from, to]);
    const out = await this.git([
      '-C',
      this.trees,
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-renames',
      from,
      to,
    ]);
    return out.split('\0').filter((p) => p !== '');
  }

  /** Why a read failed, in the words of whatever failed, naming the host the URL names; the act
   *  that clears it apart, where there is one. */
  refusedBy(err: unknown): Refused {
    const named = (r: Refused) => (this.opts.pin ? refusedNamingTheHost(r, this.opts.pin) : r);
    if (err instanceof GitRefusal) return named(err.refused);
    const stderr = hostSaid(((err as GitFailure).stderr ?? '').toString());
    const cause = stderr || (err instanceof Error ? err.message : String(err));
    return named({ cause: `reading ${this.remote} failed: ${cause}` });
  }

  /** `refusedBy` as one sentence. */
  failed(err: unknown): string {
    return saying(this.refusedBy(err));
  }
}

async function carriageIn(g: GitReading, judged: string, served: string): Promise<Carriage> {
  const j = await g.resolve(judged);
  if (!j.ok) return { kind: 'unread', why: j.why };
  const s = await g.resolve(served);
  if (!s.ok) return { kind: 'unread', why: s.why };
  const [js, ss] = [j.commit.sha, s.commit.sha];
  if (js === ss) return { kind: 'descends' };
  if ((await g.status(['-C', g.history, 'merge-base', '--is-ancestor', js, ss])) === 0) {
    return { kind: 'descends' };
  }
  let base: string;
  try {
    base = (await g.git(['-C', g.history, 'merge-base', js, ss])).trim();
  } catch (err) {
    if ((err as GitFailure).code !== 1) throw err;
    return { kind: 'unread', why: `${judged} and ${served} share no history in ${g.remote}` };
  }
  const paths = new Set([...(await g.differ(base, ss)), ...(await g.differ(base, js))]);
  return { kind: 'differs', paths: [...paths].sort() };
}

async function changedIn(g: GitReading, landing: string): Promise<ChangedPaths> {
  const read = await g.resolve(landing);
  if (!read.ok) return { kind: 'unread', why: read.why };
  const parent = read.commit.parents[0];
  if (!parent) return { kind: 'unread', why: `${landing} has no parent to diff it against` };
  return { kind: 'read', paths: [...new Set(await g.differ(parent, read.commit.sha))].sort() };
}

async function rangeIn(g: GitReading, base: string, headRef: string): Promise<RangeRead> {
  const tip = await g.head(base);
  if ('why' in tip) return { why: tip.why };
  const to = await g.resolve(headRef);
  if (!to.ok) return { why: to.why };
  const span = `${tip.sha}..${to.commit.sha}`;
  const count = Number((await g.git(['-C', g.history, 'rev-list', '--count', span])).trim());
  if (count > RANGE_COMMIT_LIMIT) {
    return {
      why: `${base}...${headRef} holds more than ${RANGE_COMMIT_LIMIT} commits, more than one release range is read for`,
    };
  }
  const log = await g.git([
    '-C',
    g.history,
    'log',
    '-z',
    '--reverse',
    '--topo-order',
    '--format=%H %P%n%B',
    span,
  ]);
  const commits = log
    .split('\0')
    .map(splitEntry)
    .filter((c): c is RangeCommit => c !== null);
  if (commits.length !== count) {
    return { why: `${g.remote} listed ${commits.length} of the ${count} commits in ${span}` };
  }
  return { commits };
}

/** The reader for `remote`, fetched as `env` (the deploy key's ssh command) allows, under `dir`. */
export function gitRepositoryReader(
  remote: string,
  env: NodeJS.ProcessEnv,
  dir: string,
  opts: { pin?: PinnedSshHost; limits?: FetchLimits } = {},
): RepositoryReader {
  const g = new GitReading(remote, env, dir, opts);
  return {
    name: remote,
    route: 'deploy_key',

    async commit(ref: string): Promise<CommitLookup> {
      try {
        const read = await g.resolve(ref);
        return read.ok ? { kind: 'found', ...read.commit } : read.lookup;
      } catch (err) {
        return { kind: 'unreadable', why: g.failed(err) };
      }
    },

    async branchHead(branch: string) {
      try {
        return await g.head(branch);
      } catch (err) {
        return { why: g.failed(err) };
      }
    },

    async contains(sha: string, branch: string): Promise<Containment> {
      try {
        const tip = await g.head(branch);
        if ('why' in tip) return tip;
        const read = await g.status(['-C', g.history, 'merge-base', '--is-ancestor', sha, tip.sha]);
        return { contains: read === 0 };
      } catch (err) {
        return { why: g.failed(err) };
      }
    },

    async carriage(judged: string, served: string): Promise<Carriage> {
      try {
        return await carriageIn(g, judged, served);
      } catch (err) {
        const { cause, clears } = g.refusedBy(err);
        const why = `${remote} could not compare ${judged} with ${served}: ${cause}`;
        return clears === undefined ? { kind: 'unread', why } : { kind: 'unread', why, clears };
      }
    },

    async changedPaths(landing: string): Promise<ChangedPaths> {
      try {
        return await changedIn(g, landing);
      } catch (err) {
        const { cause, clears } = g.refusedBy(err);
        const why = `${remote} could not read what ${landing} changed: ${cause}`;
        return clears === undefined ? { kind: 'unread', why } : { kind: 'unread', why, clears };
      }
    },

    async range(base: string, headRef: string): Promise<RangeRead> {
      try {
        return await rangeIn(g, base, headRef);
      } catch (err) {
        return { why: `${remote} could not compare ${base} with ${headRef}: ${g.failed(err)}` };
      }
    },
  };
}
