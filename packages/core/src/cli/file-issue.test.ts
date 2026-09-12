/**
 * The door, watched at the two places a stricter front-end can go wrong: a
 * malformed body that reaches `createIssue` anyway, and a duplicate refused
 * after the row is already written.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const created = vi.fn(async () => ({ deduped: false, issue: { id: 'new-row' } }));
const duplicate = vi.fn(async () => null as { id: string; issSeq: number; title: string } | null);

vi.mock('../issues/create-service.js', () => ({ createIssue: (...args: unknown[]) => created(...(args as [])) }));
vi.mock('../assistant/tools/issue-dedup.js', () => ({
  findDuplicateIssue: (...args: unknown[]) => duplicate(...(args as [])),
}));

const {
  CLI_DEDUP_OVERRIDE,
  CLI_DUPLICATE_CORPUS,
  CLI_DUPLICATE_THRESHOLD,
  fileIssueThroughCli,
} = await import('./file-issue.js');

const WRITER = { createdById: 'u1', createdVia: 'mcp' as const, actor: { agency: 'agent' } as never };

const WHOLE =
  '# A malformed filing is refused at the door\n\n' +
  '## Outcome\n\nThe door refuses it by name.\n\n' +
  '## Rules\n\nThe rule is that it holds.\n\n' +
  '## Out of scope\n\nNothing else moves at all.\n\n' +
  '## Why\n\nIt is worth a round here.\n';

function filing(over: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    title: 'A malformed filing is refused at the door',
    body: WHOLE,
    category: 'feature',
    ...over,
  };
}

function reset() {
  created.mockClear();
  duplicate.mockClear();
  duplicate.mockResolvedValue(null);
}

describe('a filing the shape refuses', () => {
  it('comes back refused, naming the section', async () => {
    reset();
    const out = await fileIssueThroughCli(filing({ body: WHOLE.replace(/## Rules[\s\S]*?\n\n/, '') }), WRITER);
    expect(out.filed).toBe(false);
    expect(out.filed === false && out.refusal).toContain('rules, invariants or acceptance');
  });

  it('never reaches createIssue', async () => {
    reset();
    await fileIssueThroughCli(filing({ body: WHOLE.replace(/## Rules[\s\S]*?\n\n/, '') }), WRITER);
    expect(created).not.toHaveBeenCalled();
  });

  it('never reaches the duplicate check either, the body being read first', async () => {
    reset();
    await fileIssueThroughCli(filing({ body: WHOLE.replace(/## Rules[\s\S]*?\n\n/, '') }), WRITER);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('says which rule refused, so a caller need not read the prose', async () => {
    reset();
    const out = await fileIssueThroughCli(filing({ body: WHOLE.replace(/## Rules[\s\S]*?\n\n/, '') }), WRITER);
    expect(out.filed === false && out.because).toBe('section');
  });
});

describe('a filing naming no category', () => {
  it('is refused with the four kinds named', async () => {
    reset();
    const out = await fileIssueThroughCli(filing({ category: undefined }), WRITER);
    expect(out.filed === false && out.refusal).toContain('bug, enhancement, feature, review');
    expect(out.filed === false && out.because).toBe('category');
  });

  it('never reaches createIssue', async () => {
    reset();
    await fileIssueThroughCli(filing({ category: undefined }), WRITER);
    expect(created).not.toHaveBeenCalled();
  });
});

describe('the near-duplicate check', () => {
  it('is asked at this door\'s own threshold and corpus, not the chat door\'s', async () => {
    reset();
    await fileIssueThroughCli(filing(), WRITER);
    expect(duplicate).toHaveBeenCalledWith(
      {},
      { projectId: 'p1', title: filing().title, description: WHOLE },
      { threshold: CLI_DUPLICATE_THRESHOLD, corpus: CLI_DUPLICATE_CORPUS },
    );
  });

  it('takes the values the caller names over this door\'s defaults', async () => {
    reset();
    await fileIssueThroughCli(filing(), WRITER, { threshold: 0.9, corpus: 10 });
    expect(duplicate).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      threshold: 0.9,
      corpus: 10,
    });
  });

  it('refuses a match, naming the key', async () => {
    reset();
    duplicate.mockResolvedValue({ id: 'x', issSeq: 42, title: 'The door refuses a body' });
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed).toBe(false);
    expect(out.filed === false && out.duplicate).toBe('ISS-42');
    expect(out.filed === false && out.refusal).toContain('ISS-42');
  });

  it('does not call createIssue for a match', async () => {
    reset();
    duplicate.mockResolvedValue({ id: 'x', issSeq: 42, title: 'The door refuses a body' });
    await fileIssueThroughCli(filing(), WRITER);
    expect(created).not.toHaveBeenCalled();
  });

  it('names, in the refusal, the flag that clears it', async () => {
    reset();
    duplicate.mockResolvedValue({ id: 'x', issSeq: 42, title: 'The door refuses a body' });
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed === false && out.refusal).toContain(CLI_DEDUP_OVERRIDE);
  });

  // cm:guard the two halves of one case: the SAME match, refused and then filed. Asserting only the wording leaves a refusal advertising a way out nobody built, which is what this pair exists to catch.
  it('files the same match when the caller sends that flag, so the way out is real', async () => {
    reset();
    duplicate.mockResolvedValue({ id: 'x', issSeq: 42, title: 'The door refuses a body' });
    const refused = await fileIssueThroughCli(filing(), WRITER);
    expect(refused.filed).toBe(false);
    expect(created).not.toHaveBeenCalled();

    const filed = await fileIssueThroughCli(filing(), WRITER, { confirmNotDuplicate: true });
    expect(filed.filed).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('does not let the flag wave a malformed body through as well', async () => {
    reset();
    duplicate.mockResolvedValue({ id: 'x', issSeq: 42, title: 'The door refuses a body' });
    const out = await fileIssueThroughCli(
      filing({ body: WHOLE.replace(/## Rules[\s\S]*?\n\n/, '') }),
      WRITER,
      { confirmNotDuplicate: true },
    );
    expect(out.filed === false && out.because).toBe('section');
    expect(created).not.toHaveBeenCalled();
  });

  it('lets a no-match filing through, which is the control that makes the line above mean something', async () => {
    reset();
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe('a filing the tracker deduped on a detector key', () => {
  it('comes back refused, naming the issue that already holds the key', async () => {
    reset();
    created.mockResolvedValueOnce({
      deduped: true,
      detectorKey: 'k',
      existingIssueId: 'row-1',
      existingIssueDisplayId: 'ISS-7',
      existingIssueStatus: 'open',
    } as never);
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed).toBe(false);
    expect(out.filed === false && out.refusal).toContain('ISS-7');
    expect(out.filed === false && out.because).toBe('detector');
  });

  it('falls back to the row id where the tracker named no key', async () => {
    reset();
    created.mockResolvedValueOnce({
      deduped: true,
      detectorKey: 'k',
      existingIssueId: 'row-1',
      existingIssueDisplayId: null,
      existingIssueStatus: 'open',
    } as never);
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed === false && out.refusal).toContain('row-1');
  });
});

describe('a filing this door accepts', () => {
  it('is written by createIssue, with the category the filing named', async () => {
    reset();
    await fileIssueThroughCli(filing(), WRITER);
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', category: 'feature', description: WHOLE }),
      WRITER,
    );
  });

  it('hands back what createIssue returned rather than a shape of its own', async () => {
    reset();
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed === true && out.created).toEqual({ deduped: false, issue: { id: 'new-row' } });
  });

  it('says nothing where the body left nothing out', async () => {
    reset();
    const out = await fileIssueThroughCli(filing(), WRITER);
    expect(out.filed === true && out.notice).toBeNull();
  });

  it('forwards the relations the filing carried, which its own parts refusal tells a filer to send', async () => {
    reset();
    const relations = [{ dependsOnId: '11111111-1111-4111-8111-111111111111', kind: 'blocks' as const }];
    await fileIssueThroughCli(filing({ relations }), WRITER);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ relations }), WRITER);
  });

  it('sends no relations key where the filing named none', async () => {
    reset();
    await fileIssueThroughCli(filing(), WRITER);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ relations: undefined }), WRITER);
  });

  it('names a nice-to-have section the body left out, and files it anyway', async () => {
    reset();
    const body = WHOLE.replace('## Why\n\nIt is worth a round here.\n', '');
    const out = await fileIssueThroughCli(filing({ body }), WRITER);
    expect(out.filed).toBe(true);
    expect(out.filed === true && out.notice).toContain('It leaves out Why');
    expect(created).toHaveBeenCalledTimes(1);
  });
});
