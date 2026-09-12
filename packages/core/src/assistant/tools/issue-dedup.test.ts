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

/** The two dials a door may set for itself (ISS-985). A call naming neither has to be the call every caller made before they existed, or the chat door's verdicts moved under it. */
function recordingDb(rows: Row[], seen: { limit?: number }): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              seen.limit = n;
              return rows;
            },
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

const NEAR: Row[] = [
  {
    id: 'iss-1',
    issSeq: 61,
    title: '[Bug] Category path renders too long on listing',
    description: 'The breadcrumb concatenates every ancestor level so it overflows.',
  },
];

const ASKED = { projectId: 'proj-1', title: 'Category path renders too long on listing', description: '' };

describe('the per-door dials', () => {
  it('reads 50 rows when no corpus is named, which is what every caller got before', async () => {
    const seen: { limit?: number } = {};
    await findDuplicateIssue(recordingDb(NEAR, seen), ASKED);
    expect(seen.limit).toBe(50);
  });

  it('reads the number a door names instead', async () => {
    const seen: { limit?: number } = {};
    await findDuplicateIssue(recordingDb(NEAR, seen), ASKED, { corpus: 200 });
    expect(seen.limit).toBe(200);
  });

  it('holds a match to 0.72 when no threshold is named', async () => {
    const seen: { limit?: number } = {};
    const weak = [{ ...NEAR[0], title: 'Category path listing' } as Row];
    expect(titleSimilarity(ASKED.title, weak[0]?.title ?? '')).toBeLessThan(0.72);
    expect(await findDuplicateIssue(recordingDb(weak, seen), ASKED)).toBeNull();
  });

  it('lets a door widen the net below 0.72, taking the same row the default refused', async () => {
    const seen: { limit?: number } = {};
    const weak = [{ ...NEAR[0], title: 'Category path listing' } as Row];
    const match = await findDuplicateIssue(recordingDb(weak, seen), ASKED, { threshold: 0.4 });
    expect(match?.issSeq).toBe(61);
  });

  it('lets a door narrow it past a match the default would have returned', async () => {
    const seen: { limit?: number } = {};
    expect(await findDuplicateIssue(recordingDb(NEAR, seen), ASKED)).not.toBeNull();
    expect(await findDuplicateIssue(recordingDb(NEAR, seen), ASKED, { threshold: 0.99 })).toBeNull();
  });

  it('reads an explicit undefined as unnamed, so a caller spreading an empty options object is unmoved', async () => {
    const seen: { limit?: number } = {};
    await findDuplicateIssue(recordingDb(NEAR, seen), ASKED, { threshold: undefined, corpus: undefined });
    expect(seen.limit).toBe(50);
  });
});
