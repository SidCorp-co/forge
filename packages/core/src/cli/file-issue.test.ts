import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DUPLICATE_THRESHOLD, RECENT_ISSUES_LIMIT } from '../assistant/tools/issue-dedup.js';
import type { IssueCreateWriter } from '../issues/create-service.js';

vi.mock('../db/client.js', () => ({ db: { stub: true } }));

type Match = { issSeq: number; title: string } | null;

const findDuplicateIssue =
  vi.fn<(db: unknown, args: unknown, search?: unknown) => Promise<Match>>();
vi.mock('../assistant/tools/issue-dedup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistant/tools/issue-dedup.js')>()),
  findDuplicateIssue: (db: unknown, args: unknown, search?: unknown) =>
    findDuplicateIssue(db, args, search),
}));

const createIssue =
  vi.fn<(input: Record<string, unknown>, writer: unknown) => Promise<Record<string, unknown>>>();
vi.mock('../issues/create-service.js', () => ({
  createIssue: (input: Record<string, unknown>, writer: unknown) => createIssue(input, writer),
}));

const { CLI_DUPLICATE_CORPUS, CLI_DUPLICATE_THRESHOLD, fileIssueThroughCli } = await import(
  './file-issue.js'
);

const WRITER = { createdById: 'u', createdVia: 'mcp', actor: {} } as unknown as IssueCreateWriter;

const BODY = [
  '## Outcome\n\nthe layer refuses what the terminal refuses',
  '## Rules\n\nthe API side does not move at all',
  '## Out of scope\n\nthe plugin repo is reached by issue',
].join('\n\n');

const FILING = {
  projectId: 'p1',
  title: 'a filing the CLI layer accepts reaches the one create path',
  body: BODY,
  category: 'feature',
};

beforeEach(() => {
  findDuplicateIssue.mockReset().mockResolvedValue(null);
  createIssue.mockReset().mockResolvedValue({ deduped: false, issue: { id: 'made' } });
});

describe("the required field, which is this layer's own policy", () => {
  it.each([undefined, null, '   '])(
    'a filing naming no category (%s) is refused',
    async (given) => {
      const answer = await fileIssueThroughCli({ ...FILING, category: given }, WRITER);
      expect(answer.filed).toBe(false);
      if (answer.filed) return;
      for (const kind of ['bug', 'enhancement', 'feature', 'review']) {
        expect(answer.refusal).toContain(kind);
      }
      expect(createIssue).not.toHaveBeenCalled();
    },
  );
});

describe('what an accepted filing reaches', () => {
  it('is written by createIssue, with the notice its body earned', async () => {
    const answer = await fileIssueThroughCli(FILING, WRITER);
    expect(answer.filed).toBe(true);
    if (!answer.filed) return;
    expect(answer.issue).toEqual({ id: 'made' });
    expect(answer.notice).toContain('Why');
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p1',
      description: BODY,
      category: 'feature',
    });
  });

  it('a body the shape refuses never reaches the duplicate check or the create', async () => {
    const answer = await fileIssueThroughCli(
      { ...FILING, body: '## Rules\n\nonly this one' },
      WRITER,
    );
    expect(answer.filed).toBe(false);
    expect(findDuplicateIssue).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe("the near-duplicate check, at this door's own policy", () => {
  it("is asked at a threshold and over a corpus that are not the chat door's", async () => {
    await fileIssueThroughCli(FILING, WRITER);
    expect(findDuplicateIssue.mock.calls[0]?.[2]).toEqual({
      threshold: CLI_DUPLICATE_THRESHOLD,
      corpusSize: CLI_DUPLICATE_CORPUS,
    });
    expect(CLI_DUPLICATE_THRESHOLD).not.toBe(DUPLICATE_THRESHOLD);
    expect(CLI_DUPLICATE_CORPUS).not.toBe(RECENT_ISSUES_LIMIT);
  });

  it('a match is refused naming its key, and the create never runs', async () => {
    findDuplicateIssue.mockResolvedValue({ issSeq: 61, title: 'the open one' });
    const answer = await fileIssueThroughCli(FILING, WRITER);
    expect(answer.filed).toBe(false);
    if (answer.filed) return;
    expect(answer.duplicate).toBe('ISS-61');
    expect(answer.refusal).toContain('ISS-61');
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('a no-match control files, so the refusal above is the check and not the default', async () => {
    findDuplicateIssue.mockResolvedValue(null);
    expect((await fileIssueThroughCli(FILING, WRITER)).filed).toBe(true);
  });
});

// cm:guard the layer is a CALLER of the create path, never a second writer of the table — one-create-path.test.ts freezes the allowlist repo-wide, and this is the same assertion scoped to the directory ISS-985 added
describe('the layer owns no write of its own', () => {
  it('no file under src/cli/ inserts into the issues table', () => {
    const dir = import.meta.dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /\.insert\(issues\)/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('reaches the near-duplicate check in assistant/tools/issue-dedup.ts', () => {
    const source = readFileSync(join(import.meta.dirname, 'file-issue.ts'), 'utf8');
    expect(source).toContain(
      "import { findDuplicateIssue } from '../assistant/tools/issue-dedup.js'",
    );
    expect(source).toContain("from '../issues/create-service.js'");
  });
});
