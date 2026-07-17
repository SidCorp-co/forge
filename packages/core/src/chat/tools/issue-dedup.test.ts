import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/client.js';
import { findDuplicateIssue, titleSimilarity } from './issue-dedup.js';

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

function fakeDb(rows: Row[] | (() => never)): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
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
