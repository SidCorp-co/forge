import { beforeEach, describe, expect, it, vi } from 'vitest';

let heldPrefixes: string[] = [];
let holders: Record<string, { projectId: string | null }> = {};
let activePrefixes: Record<string, string | null> = {};
/** The issues table: what the mocked db answers a `where` over, by column name. */
let table: Array<{ id: string; project_id: string; iss_seq: number }> = [];

type Cond =
  | { op: 'eq'; col: string; value: unknown }
  | { op: 'in'; col: string; values: unknown[] }
  | { op: 'and'; parts: Cond[] };

const matches = (row: Record<string, unknown>, c: Cond): boolean =>
  c.op === 'eq'
    ? row[c.col] === c.value
    : c.op === 'in'
      ? c.values.includes(row[c.col])
      : c.parts.every((part) => matches(row, part));

vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async (projectId: string) => activePrefixes[projectId] ?? null,
  heldIssuePrefixes: async () => heldPrefixes,
  issuePrefixHolder: async (prefix: string) => holders[prefix] ?? null,
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: (fields: Record<string, { name: string }>) => ({
      from: () => ({
        where: (cond: Cond) => {
          const rows = table
            .filter((row) => matches(row, cond))
            .map((row) =>
              Object.fromEntries(
                Object.entries(fields).map(([key, col]) => [
                  key,
                  (row as Record<string, unknown>)[col.name],
                ]),
              ),
            );
          return Object.assign(Promise.resolve(rows), {
            limit: async (n: number) => rows.slice(0, n),
          });
        },
      }),
    }),
  },
}));
vi.mock('drizzle-orm', async (original) => {
  const real = await original<typeof import('drizzle-orm')>();
  return {
    ...real,
    eq: (col: { name: string }, value: unknown) => ({ op: 'eq', col: col.name, value }),
    inArray: (col: { name: string }, values: unknown[]) => ({ op: 'in', col: col.name, values }),
    and: (...parts: Cond[]) => ({ op: 'and', parts }),
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

const ISSUE_1280 = '081510ce-0000-4000-8000-000000001280';
const ISSUE_OTHER = '081510ce-0000-4000-8000-000000000005';
const ISSUE_NOBODY = '081510ce-0000-4000-8000-00000000dead';
const held = (...seqs: number[]) => {
  table = seqs.map((n) => ({ id: `row-${n}`, project_id: 'p1', iss_seq: n }));
};

beforeEach(() => {
  heldPrefixes = [];
  holders = {};
  activePrefixes = {};
  table = [{ id: ISSUE_1280, project_id: 'p1', iss_seq: 1280 }];
});

describe('readIssueSearchTerm (ISS-1334)', () => {
  it.each(['ISS-1280', 'iss-1280', '1280', '  1280 ', '00000000000000001280'])(
    'reads %j as the key 1280',
    async (term) => {
      expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeqs: [1280] });
    },
  );

  it('reads a prefix the project holds as a key', async () => {
    heldPrefixes = ['FP', 'FPL'];
    activePrefixes = { p1: 'FP' };

    expect(await readIssueSearchTerm('p1', 'fpl-1280')).toEqual({ kind: 'key', issSeqs: [1280] });
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
    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeqs: [1280] });
  });

  it('reads a held prefix written with a space as a key', async () => {
    heldPrefixes = ['FP'];
    activePrefixes = { p1: 'FP' };

    expect(await readIssueSearchTerm('p1', 'fp 1280')).toEqual({ kind: 'key', issSeqs: [1280] });
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
    held(2_147_483_647);

    expect(await readIssueSearchTerm('p1', '2147483647')).toEqual({
      kind: 'key',
      issSeqs: [2_147_483_647],
    });
  });

  it('refuses a key the project holds no issue at, naming it in both forms', async () => {
    activePrefixes = { p1: 'FP' };

    const err = await refusal('9999');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_NOT_HELD', 404]);
    expect(err.message).toContain('FP-9999 (ISS-9999)');
  });
});

describe('a key written the way an editor or a clipboard writes it', () => {
  it.each([
    ['an en dash', 'ISS\u20131280'],
    ['an em dash', 'ISS\u20141280'],
    ['a minus sign', 'ISS\u22121280'],
    ['a fullwidth hyphen', 'ISS\uFF0D1280'],
    ['a fullwidth number sign', '\uFF031280'],
    ['a fullwidth number sign and a space', '\uFF03 1280'],
    ['a trailing zero-width space', 'ISS-1280\u200B'],
    ['a zero-width joiner inside', 'IS\u200DS-1280'],
    ['a byte order mark ahead', '\uFEFFISS-1280'],
    ['a left-to-right mark', '\u200EISS-1280\u200F'],
    ['a soft hyphen', 'ISS\u00AD-1280'],
  ])('reads %s as the key 1280', async (_name, term) => {
    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeqs: [1280] });
  });

  it('answers a text term as the term it was given, zero-width characters and all', async () => {
    const term = 'release\u200B door';

    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
  });
});

describe('two or more keys pasted together', () => {
  beforeEach(() => held(1280, 1281));

  it.each([
    'ISS-1280 ISS-1281',
    'ISS 1280 ISS 1281',
    '#1280 #1281',
    '#1280, #1281',
    'ISS-1280,ISS-1281',
    '(ISS-1280), (ISS-1281).',
    'ISS-1280; ISS\u20141281',
    ' ISS-1280\n#1281 ',
  ])('reads %j as both keys', async (term) => {
    expect(await readIssueSearchTerm('p1', term)).toEqual({
      kind: 'key',
      issSeqs: [1280, 1281],
    });
  });

  it('names each key once', async () => {
    expect(await readIssueSearchTerm('p1', 'ISS-1281 #1280 ISS-1281')).toEqual({
      kind: 'key',
      issSeqs: [1281, 1280],
    });
  });

  it('refuses the whole list by the key this project holds no issue at', async () => {
    const err = await refusal('ISS-1280 ISS-9999');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_NOT_HELD', 404]);
    expect(err.message.startsWith('`ISS-9999` reads as an issue key')).toBe(true);
  });

  it('refuses the whole list by a key whose prefix another project holds', async () => {
    holders = { OTH: { projectId: 'p2' } };

    const err = await refusal('ISS-1280 OTH-5');

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_FOREIGN_PREFIX', 400]);
    expect(err.message).toContain('`OTH`');
  });

  it('refuses the whole list by a number out of range', async () => {
    const err = await refusal('ISS-1280 #2147483648');

    expect(err.code).toBe('ISSUE_KEY_OUT_OF_RANGE');
  });

  it('reads a list one of whose units is a never-held prefix as text', async () => {
    const term = 'ISS-1280 UTF-8';

    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
  });

  it.each(['500 404', '2024 2025', '1280 1281', 'ISS-1280 1281', '#1280 1281', '12.5', '#1280.0'])(
    'reads %j, which has a bare number beside another number, as text',
    async (term) => {
      expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
    },
  );
});

describe('a pasted link to an issue page', () => {
  beforeEach(() => {
    table = [
      { id: ISSUE_1280, project_id: 'p1', iss_seq: 1280 },
      { id: ISSUE_OTHER, project_id: 'p2', iss_seq: 5 },
    ];
  });

  it.each([
    `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${ISSUE_1280}`,
    `http://localhost:3100/projects/forge-dev/issues/${ISSUE_1280}/`,
    `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${ISSUE_1280}?tab=plan#comments`,
    `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${ISSUE_1280.toUpperCase()}`,
    `  https://forge-beta.sidcorp.co/projects/forge-dev/issues/${ISSUE_1280}\u200B`,
  ])('reads %j as the issue it opens', async (term) => {
    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'key', issSeqs: [1280] });
  });

  it('reads a link whose last segment is a key as that key', async () => {
    expect(
      await readIssueSearchTerm(
        'p1',
        'https://forge-beta.sidcorp.co/projects/forge-dev/issues/ISS-1280',
      ),
    ).toEqual({ kind: 'key', issSeqs: [1280] });
  });

  it('refuses a link to an issue of another project, naming its key and whose it is', async () => {
    activePrefixes = { p2: 'OTH' };

    const err = await refusal(`https://forge-beta.sidcorp.co/projects/other/issues/${ISSUE_OTHER}`);

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_FOREIGN_PREFIX', 400]);
    expect(err.message).toContain('`OTH-5`');
    expect(err.message).toContain('belongs to another project');
  });

  it('refuses a link to an issue no project holds, naming the id', async () => {
    const err = await refusal(
      `https://forge-beta.sidcorp.co/projects/forge-dev/issues/${ISSUE_NOBODY}`,
    );

    expect([err.code, err.status]).toEqual(['ISSUE_KEY_NOT_HELD', 404]);
    expect(err.message).toContain(`\`${ISSUE_NOBODY}\``);
  });

  it.each([
    'https://github.com/SidCorp-co/forge/issues/874',
    'https://forge-beta.sidcorp.co/projects/forge-dev/issues',
    'https://example.com/docs/page',
    'https://forge-beta.sidcorp.co/projects/forge-dev/issues/not-an-id',
    'https://forge-beta.sidcorp.co/projects/forge-dev/issues/UTF-8',
    'http://',
  ])('reads %j, which opens no issue of Forge, as text', async (term) => {
    expect(await readIssueSearchTerm('p1', term)).toEqual({ kind: 'text', text: term });
  });
});
