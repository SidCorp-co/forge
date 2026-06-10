import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    LITELLM_API_URL: 'http://litellm.test',
    LITELLM_API_KEY: 'k',
    LITELLM_MODEL: 'fast-model',
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const indexMemoryMock = vi.fn();
vi.mock('./indexer.js', () => ({
  indexMemory: (input: unknown, opts: unknown) => indexMemoryMock(input, opts),
}));

// Generic table-aware query stub: every read chain ends in .limit(); results
// are keyed off the table reference passed to .from().
type Row = Record<string, unknown>;
const tableResults = new Map<unknown, Row[]>();
const insertedValues: Array<{ table: unknown; values: Row }> = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const result = () => Promise.resolve(tableResults.get(table) ?? []);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => result(),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        insertedValues.push({ table, values: v });
        return Promise.resolve();
      },
    }),
  },
}));

const schema = await import('../db/schema.js');
const { hasMemoryWorthyContent, parseExtractionOutput, runExtractionForIssue } = await import(
  './extraction.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function llmResponds(content: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  indexMemoryMock.mockReset();
  indexMemoryMock.mockResolvedValue({
    id: 'm-1',
    embeddedAt: new Date(),
    truncated: false,
    degraded: false,
  });
  tableResults.clear();
  insertedValues.length = 0;
  tableResults.set(schema.issues, [{ title: 'Fix login bug' }]);
  tableResults.set(schema.memories, []);
  tableResults.set(schema.knowledgeEdges, []);
});

describe('hasMemoryWorthyContent', () => {
  it('passes on correction language, including Vietnamese', () => {
    expect(hasMemoryWorthyContent(['không phải branch main, là master'])).toBe(true); // i18n-allow: Vietnamese gate fixture
    expect(hasMemoryWorthyContent(['actually the endpoint is /v2'])).toBe(true);
  });

  it('rejects pure status chatter', () => {
    expect(hasMemoryWorthyContent(['lgtm', 'done', 'passed'])).toBe(false);
    expect(hasMemoryWorthyContent([])).toBe(false);
  });

  it('passes substantial non-trivial content', () => {
    expect(
      hasMemoryWorthyContent([
        'The deploy pipeline requires the integration branch to be rebased onto develop before forge-release runs, otherwise the merge check fails.',
      ]),
    ).toBe(true);
  });
});

describe('parseExtractionOutput', () => {
  it('parses fenced JSON and clamps to limits', () => {
    const facts = Array.from({ length: 5 }, (_, i) => ({
      fact: `fact number ${i}`,
      category: 'correction',
    }));
    const parsed = parseExtractionOutput(`\`\`\`json\n${JSON.stringify({ facts, edges: [] })}\n\`\`\``);
    expect(parsed?.facts).toHaveLength(3);
    expect(parsed?.facts[0]?.category).toBe('correction');
  });

  it('defaults invalid categories to convention and normalizes edges', () => {
    const parsed = parseExtractionOutput(
      JSON.stringify({
        facts: [{ fact: 'use python3 always', category: 'bogus' }],
        edges: [{ subject: ' API ', predicate: 'Uses', object: 'V2 ' }],
      }),
    );
    expect(parsed?.facts[0]?.category).toBe('convention');
    expect(parsed?.edges[0]).toEqual({ subject: 'api', predicate: 'uses', object: 'v2' });
  });

  it('returns null on garbage', () => {
    expect(parseExtractionOutput('the model rambled instead of JSON')).toBeNull();
  });
});

describe('runExtractionForIssue', () => {
  it('skips without an LLM call when comments are pure chatter', async () => {
    tableResults.set(schema.comments, [{ body: 'lgtm' }, { body: 'done' }]);
    const result = await runExtractionForIssue(PROJECT_ID, ISSUE_ID);
    expect(result.skipped).toBe('gated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes facts with semantic dedup and edges with issue provenance', async () => {
    tableResults.set(schema.comments, [
      { body: 'actually the deploy branch is master, not main — please remember this' },
    ]);
    llmResponds(
      JSON.stringify({
        facts: [{ fact: 'deploy branch is master, not main', category: 'correction' }],
        edges: [{ subject: 'deploy', predicate: 'uses', object: 'master' }],
      }),
    );

    const result = await runExtractionForIssue(PROJECT_ID, ISSUE_ID);

    expect(result).toEqual({ facts: 1, edges: 1 });
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'knowledge',
        sourceRef: expect.stringMatching(/^extracted:[0-9a-f]{12}$/),
        metadata: expect.objectContaining({ category: 'correction', origin: 'extraction' }),
      }),
      { semanticDedup: true },
    );
    expect(insertedValues[0]?.values).toMatchObject({
      subject: 'deploy',
      predicate: 'uses',
      object: 'master',
      sourceMemoryId: `issue:${ISSUE_ID}`,
    });
  });

  it('skips duplicate edges', async () => {
    tableResults.set(schema.comments, [{ body: 'actually the deploy branch is master' }]);
    tableResults.set(schema.knowledgeEdges, [{ id: 'edge-1' }]);
    llmResponds(
      JSON.stringify({
        facts: [],
        edges: [{ subject: 'deploy', predicate: 'uses', object: 'master' }],
      }),
    );
    const result = await runExtractionForIssue(PROJECT_ID, ISSUE_ID);
    expect(result.edges).toBe(0);
    expect(insertedValues).toHaveLength(0);
  });

  it('survives a failing LLM', async () => {
    tableResults.set(schema.comments, [{ body: 'actually the deploy branch is master' }]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await runExtractionForIssue(PROJECT_ID, ISSUE_ID);
    expect(result.skipped).toBe('llm-failed');
  });
});
