import { beforeEach, describe, expect, it, vi } from 'vitest';

let heldPrefixes: string[] = [];
let holders: Record<string, { projectId: string | null }> = {};
let activePrefix: string | null = null;
let heldSeqs: number[] = [];
const seqAsked: number[] = [];

vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => activePrefix,
  heldIssuePrefixes: async () => heldPrefixes,
  issuePrefixHolder: async (prefix: string) => holders[prefix] ?? null,
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const seq = seqAsked.at(-1) ?? 0;
            return heldSeqs.includes(seq) ? [{ id: `row-${seq}` }] : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock('drizzle-orm', async (original) => {
  const real = await original<typeof import('drizzle-orm')>();
  return {
    ...real,
    eq: (col: unknown, value: unknown) => {
      if (typeof value === 'number') seqAsked.push(value);
      return real.eq(col as never, value as never);
    },
  };
});

const { readIssueSearchTerm, IssueSearchKeyRefused } = await import('./search-term.js');

async function refusal(term: string) {
  try {
    await readIssueSearchTerm('p1', term);
  } catch (err) {
    if (err instanceof IssueSearchKeyRefused) return err;
    throw err;
  }
  throw new Error(`${term} was not refused`);
}

describe('readIssueSearchTerm (ISS-1334)', () => {
  beforeEach(() => {
    heldPrefixes = [];
    holders = {};
    activePrefix = null;
    heldSeqs = [1280];
    seqAsked.length = 0;
  });

  it.each(['ISS-1280', 'iss-1280', '1280', '  1280 ', '00000000000000001280'])(
    'reads %j as the key 1280',
    async (term) => {
      expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeq: 1280 });
    },
  );

  it('reads a prefix the project holds as a key', async () => {
    heldPrefixes = ['FP', 'FPL'];
    activePrefix = 'FP';

    expect(await readIssueSearchTerm('p1', 'fpl-1280')).toEqual({ kind: 'key', issSeq: 1280 });
  });

  it.each(['release door', 'ISS-1280 again', 'UTF-8', 'UTF-0', 'UTF-99999999999'])(
    'reads %j as text',
    async (term) => {
      expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
    },
  );

  it('refuses a prefix another project holds, naming it and what this project answers to', async () => {
    heldPrefixes = ['FD'];
    holders = { OTH: { projectId: 'p2' } };

    const err = await refusal('OTH-5');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_FOREIGN_PREFIX', 400]);
    expect(err.message).toContain('`OTH`');
    expect(err.message).toContain('`ISS`, `FD`');
  });

  it('refuses a prefix whose project is gone, since it stays spent, without saying anyone holds it', async () => {
    holders = { GONE: { projectId: null } };

    const err = await refusal('GONE-5');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_FOREIGN_PREFIX', 400]);
    expect(err.message).toContain('no longer exists');
    expect(err.message).not.toContain('another project holds');
  });

  it.each([
    'ISS 1280',
    'iss  1280',
    'ISS - 1280',
    '#1280',
    '#ISS-1280',
    'ISS-1280,',
    'ISS-1280.',
    'ISS-1280;',
    '(ISS-1280)',
    '[ISS-1280]',
    '`ISS-1280`',
    ' (#1280), ',
  ])('reads the near-form %j as the key 1280', async (term) => {
    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeq: 1280 });
  });

  it('reads a held prefix written with a space as a key', async () => {
    heldPrefixes = ['FP'];
    activePrefix = 'FP';

    expect(await readIssueSearchTerm('p1', 'fp 1280')).toEqual({ kind: 'key', issSeq: 1280 });
  });

  it.each(['"500"', '"ISS-1280"', 'HTTP 500', 'UTF 8', 'ISS1280', '1.5', '1280.0', '#tag'])(
    'reads %j as text',
    async (term) => {
      expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
    },
  );

  it('quotes the key as read, so a wrapped term nests no backtick in the sentence', async () => {
    const err = await refusal('`ISS-9999`,');

    expect(err.code).toBe('ISSUE_KEY_NOT_HELD');
    expect(err.message.startsWith('`ISS-9999` reads as an issue key')).toBe(true);
  });

  it.each(['0', 'ISS-0', '2147483648', '21474836470'])(
    'refuses %j as out of range',
    async (term) => {
      const err = await refusal(term);
      expect([err.code, err.status]).toEqual(['ISSUE_KEY_OUT_OF_RANGE', 400]);
    },
  );

  it('accepts the largest number an issue can carry', async () => {
    heldSeqs = [2_147_483_647];

    expect(await readIssueSearchTerm('p1', '2147483647')).toEqual({
      kind: 'key',
      issSeq: 2_147_483_647,
    });
  });

  it('refuses a key the project holds no issue at, naming it in both forms', async () => {
    activePrefix = 'FP';

    const err = await refusal('9999');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_NOT_HELD', 404]);
    expect(err.message).toContain('FP-9999 (ISS-9999)');
  });
});
