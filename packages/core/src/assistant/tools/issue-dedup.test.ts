import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/client.js';
import {
  DUPLICATE_THRESHOLD,
  findDuplicateIssue,
  RECENT_ISSUES_LIMIT,
  titleSimilarity,
} from './issue-dedup.js';

describe('titleSimilarity', () => {
  it('is 1 for identical titles', () => {
    expect(titleSimilarity('Category path too long', 'Category path too long')).toBe(1);
  });

  it('is near 1 for near-duplicate titles (case/punctuation differences)', () => {
    const score = titleSimilarity(
      '[Bug] Category path renders too long on listing',
      'category path renders too long on listing!',
    );
    expect(score).toBeGreaterThan(0.72);
  });

  it('is 0 for disjoint titles', () => {
    expect(titleSimilarity('Login page crashes on Safari', 'Add dark mode toggle')).toBe(0);
  });

  it('is 0 when either input has no meaningful tokens', () => {
    expect(titleSimilarity('', 'Category path too long')).toBe(0);
    expect(titleSimilarity('!!!', 'Category path too long')).toBe(0);
  });
});

type Row = { id: string; issSeq: number; title: string; description: string | null };

function fakeDb(rows: Row[] | (() => never), read: number[] = []): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              read.push(n);
              if (typeof rows === 'function') return rows();
              return rows;
            },
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

describe('findDuplicateIssue', () => {
  it('returns the best match above the threshold', async () => {
    const description = 'The breadcrumb concatenates every ancestor level so it overflows.';
    const db = fakeDb([
      {
        id: 'iss-1',
        issSeq: 61,
        title: '[Bug] Category path renders too long on listing',
        description,
      },
      { id: 'iss-2', issSeq: 62, title: 'Unrelated dark mode request', description: 'n/a' },
    ]);
    const match = await findDuplicateIssue(db, {
      projectId: 'proj-1',
      title: 'Category path renders too long on listing',
      description,
    });
    expect(match).toEqual({
      id: 'iss-1',
      issSeq: 61,
      title: '[Bug] Category path renders too long on listing',
    });
  });

  it('flags a repeat whose title clears the threshold even though its description is worded differently', async () => {
    const db = fakeDb([
      {
        id: 'iss-6',
        issSeq: 6,
        title: '[Bug] Login page blank screen after OAuth redirect on Safari 17',
        description:
          'Problem: on Safari 17, after completing the OAuth redirect the storefront login page renders a blank white screen. Expected the signed-in home page.',
      },
    ]);
    const match = await findDuplicateIssue(db, {
      projectId: 'proj-1',
      title: 'Safari 17: login page blank after OAuth redirect',
      description:
        'Bug report from chat: reproduces every attempt; user lands on an empty page once the identity provider sends them back.',
    });
    expect(match?.issSeq).toBe(6);
  });

  it('returns null when nothing clears the threshold', async () => {
    const db = fakeDb([
      { id: 'iss-1', issSeq: 61, title: 'Add dark mode toggle', description: 'n/a' },
    ]);
    const match = await findDuplicateIssue(db, {
      projectId: 'proj-1',
      title: 'Login page crashes on Safari',
      description: 'Stack trace attached.',
    });
    expect(match).toBeNull();
  });

  it('returns null (never throws) when nothing exists yet', async () => {
    const db = fakeDb([]);
    const match = await findDuplicateIssue(db, {
      projectId: 'proj-1',
      title: 'Any title',
      description: 'Any description',
    });
    expect(match).toBeNull();
  });

  it('fails open on a DB error', async () => {
    const db = fakeDb(() => {
      throw new Error('connection reset');
    });
    const match = await findDuplicateIssue(db, {
      projectId: 'proj-1',
      title: 'Any title',
      description: 'Any description',
    });
    expect(match).toBeNull();
  });
});

// cm:guard the DEFAULTED call is the chat door's verdict — ISS-985 gave this function an optional threshold and corpus size for the CLI door, and a default that drifted would move a door that issue promised not to touch
describe('findDuplicateIssue: the per-door options (ISS-985)', () => {
  const rows: Row[] = [
    { id: 'iss-1', issSeq: 61, title: 'Category path renders too long', description: 'n/a' },
  ];
  const near = {
    projectId: 'proj-1',
    title: 'Category path renders too long on listing',
    description: 'n/a',
  };

  it("reads the chat door's corpus size and floor when given neither", async () => {
    const read: number[] = [];
    const match = await findDuplicateIssue(fakeDb(rows, read), near);
    expect(read).toEqual([RECENT_ISSUES_LIMIT]);
    expect(match).toBeNull();
    expect(titleSimilarity(near.title, rows[0]?.title ?? '')).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('a lower floor matches what the default refused, so the default is doing the refusing', async () => {
    const match = await findDuplicateIssue(fakeDb(rows), near, { threshold: 0.6 });
    expect(match?.issSeq).toBe(61);
  });

  it('a corpus size of its own reaches the query', async () => {
    const read: number[] = [];
    await findDuplicateIssue(fakeDb(rows, read), near, { corpusSize: 200 });
    expect(read).toEqual([200]);
  });
});
