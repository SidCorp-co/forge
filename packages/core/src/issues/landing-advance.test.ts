/**
 * ISS-1421 round 7 — how a later commit stands against the one a mark holds, and the move it makes.
 * The repository is a client answering compares as GitHub does; the row is the merge-record module,
 * so a lost compare-and-swap can be staged. Postgres proves the swap itself:
 * `tests/integration/landing-moves-forward-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRepoClient } from '../integrations/github/client.js';
import type { LiveSource } from '../projects/live-source.js';

const held: Array<string | null> = [];
const writes: Array<{ commitSha: string; supersedes: string | null | undefined }> = [];
let lose = 0;
vi.mock('./merge-record.js', async (original) => ({
  ...(await original<typeof import('./merge-record.js')>()),
  readMergeColumns: async () => ({
    mergedAt: new Date(),
    commitSha: held.length > 1 ? (held.shift() as string | null) : (held[0] ?? null),
    landing: null,
    claimedCommit: null,
  }),
  recordIssueMerge: async (
    _db: unknown,
    args: { evidence: { commitSha: string; supersedes?: string | null } },
  ) => {
    writes.push({ commitSha: args.evidence.commitSha, supersedes: args.evidence.supersedes });
    if (lose > 0) {
      lose -= 1;
      return { wrote: false };
    }
    return { wrote: true };
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { moveLandingForward, standingAgainst, sameCommit } = await import('./landing-advance.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** `ahead[x]` lists every commit x carries. */
function github(ahead: Record<string, string[]>, fail = false): GitHubRepoClient {
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'o',
    repo: 'r',
    fullName: 'o/r',
    async get<T>(path: string): Promise<T> {
      if (fail) throw new Error('HTTP 502');
      const [, base = '', head = ''] =
        /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(path) ?? [];
      if (base === head) return { status: 'identical' } as T;
      if (ahead[head]?.includes(base)) return { status: 'ahead' } as T;
      if (ahead[base]?.includes(head)) return { status: 'behind' } as T;
      return { status: 'diverged' } as T;
    },
    async publish<T>(): Promise<T> {
      throw new Error('a repository read never publishes');
    },
  };
}

const via = (client: GitHubRepoClient) => ({
  source: async (): Promise<LiveSource> => ({ kind: 'binding', client }),
});
const line = via(github({ [B]: [A], [C]: [A, B] }));

beforeEach(() => {
  held.length = 0;
  writes.length = 0;
  lose = 0;
});

describe('standingAgainst', () => {
  it.each([
    ['the same commit', A, A, 'same'],
    ['an abbreviation of it', A, A.slice(0, 9), 'same'],
    ['a later commit on its line', A, C, 'forward'],
    ['an earlier one it carries', C, A, 'contained'],
  ])('reads %s', async (_, h, candidate, kind) => {
    expect((await standingAgainst('p', h, candidate, line)).kind).toBe(kind);
  });

  it('reads a commit on another line as other', async () => {
    expect(await standingAgainst('p', A, B, via(github({})))).toEqual({ kind: 'other' });
  });

  it('reads a failed compare as unread, naming why, never as other', async () => {
    const read = await standingAgainst('p', A, B, via(github({}, true)));
    expect(read.kind).toBe('unread');
    expect(read.kind === 'unread' && read.why).toContain('o/r could not compare');
  });

  it('reads a project with no way to read its repository as unread', async () => {
    const refused = {
      source: async (): Promise<LiveSource> => ({
        kind: 'refused',
        reason: 'no binding',
        cause: 'no binding',
        unbound: true,
        route: 'binding',
      }),
    };
    expect(await standingAgainst('p', A, B, refused)).toEqual({
      kind: 'unread',
      why: 'no binding',
    });
  });

  it('takes no abbreviation of nothing as the same commit', () => {
    expect(sameCommit('', A)).toBe(false);
  });
});

describe('moveLandingForward', () => {
  const candidate = (sha: string) => ({ sha, at: new Date(), via: 'event' as const });

  it('writes the later commit, naming the one it moves from', async () => {
    held.push(A);
    expect(
      await moveLandingForward({ issueId: 'i', projectId: 'p', candidate: candidate(C) }, line),
    ).toEqual({ kind: 'moved', from: A, to: C });
    expect(writes).toEqual([{ commitSha: C, supersedes: A }]);
  });

  it('reads the row again after losing the swap, and moves on from what won', async () => {
    held.push(A, B);
    lose = 1;
    const outcome = await moveLandingForward(
      { issueId: 'i', projectId: 'p', candidate: candidate(C) },
      line,
    );
    expect(outcome).toEqual({ kind: 'moved', from: B, to: C });
    expect(writes).toEqual([
      { commitSha: C, supersedes: A },
      { commitSha: C, supersedes: B },
    ]);
  });

  it('writes nothing where what won already carries the candidate', async () => {
    held.push(A, C);
    lose = 1;
    const outcome = await moveLandingForward(
      { issueId: 'i', projectId: 'p', candidate: candidate(B) },
      line,
    );
    expect(outcome).toEqual({ kind: 'contained', held: C });
    expect(writes).toHaveLength(1);
  });

  it('reports a swap lost three times as unread, never as a move', async () => {
    held.push(A);
    lose = 3;
    const outcome = await moveLandingForward(
      { issueId: 'i', projectId: 'p', candidate: candidate(C) },
      line,
    );
    expect(outcome.kind).toBe('unread');
    expect(writes).toHaveLength(3);
  });

  it('has nothing to move from on a row that holds no commit', async () => {
    held.push(null);
    expect(
      await moveLandingForward({ issueId: 'i', projectId: 'p', candidate: candidate(C) }, line),
    ).toEqual({ kind: 'empty' });
    expect(writes).toEqual([]);
  });
});
