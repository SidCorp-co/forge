/**
 * The three answers, and the reason there are three.
 *
 * The gate this is built on returns ONE value for "nothing is declared", "the
 * config could not be read" and "everything is met". Publishing that value on a
 * pull request would tell three different readers the same thing, and two of
 * them the wrong thing. Every test here plants one of those three states and
 * asserts the answer does not read as either of the others.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

type Standing = { status: string; projectId: string };

let standing: Standing | undefined;
let selectRaises: Error | null = null;

const selectLimit = vi.fn(async () => {
  if (selectRaises) throw selectRaises;
  return standing ? [standing] : [];
});
const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }));
vi.mock('../../db/client.js', () => ({ db: { select } }));

const readStrict = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  declared: [],
  met: [],
  unmet: [],
}));
vi.mock('../../issues/entry-criteria.js', () => ({
  readEntryCriteriaStrict: (...args: unknown[]) => readStrict(...args),
}));

const { CONTRACT_SOURCE, contractAnswerForIssue } = await import('./contract-answer.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  selectRaises = null;
  standing = { status: 'developed', projectId: PROJECT_ID };
  readStrict.mockResolvedValue({ declared: [], met: [], unmet: [] });
});

describe('the answer is derived from the declaration for the status the issue stands in', () => {
  it('asks the tracker`s own reader, for this issue at this status', async () => {
    readStrict.mockResolvedValue({ declared: ['plan'], met: ['plan'], unmet: [] });
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(readStrict).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, issueId: ISSUE_ID, status: 'developed' }),
    );
    expect(answer.kind).toBe('judged');
    expect(answer).toMatchObject({ status: 'developed' });
  });

  it('carries the met and the unmet through, with the tracker`s own remedy', async () => {
    readStrict.mockResolvedValue({
      declared: ['plan', 'merged_mark'],
      met: ['plan'],
      unmet: [{ key: 'merged_mark', detail: 'this issue carries no merged mark' }],
    });
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer).toMatchObject({
      kind: 'judged',
      met: ['plan'],
      unmet: [{ key: 'merged_mark', detail: 'this issue carries no merged mark' }],
    });
  });
});

describe('the two answers that judge nothing are not the same answer', () => {
  it('is `none-declared` where the project declares nothing for that status', async () => {
    readStrict.mockResolvedValue({ declared: [], met: [], unmet: [] });
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer.kind).toBe('none-declared');
  });

  it('is `unreadable` where the declaration could not be read, never `none-declared`', async () => {
    readStrict.mockRejectedValue(new Error('connection terminated'));
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer.kind).toBe('unreadable');
    expect(answer).toMatchObject({ status: 'developed', reason: 'connection terminated' });
  });

  it('is `unreadable` where a criterion raised, never a criterion reported met', async () => {
    readStrict.mockRejectedValue(new Error('evidence query failed'));
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer.kind).toBe('unreadable');
    expect(answer).toMatchObject({ reason: 'evidence query failed' });
  });

  it('is `unreadable` with no status at all where the issue row is gone', async () => {
    standing = undefined;
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer).toMatchObject({
      kind: 'unreadable',
      status: null,
      reason: 'no issue row was found',
    });
  });

  it('is `unreadable` where the issue read itself raised', async () => {
    selectRaises = new Error('terminating connection due to administrator command');
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer).toMatchObject({ kind: 'unreadable', status: null });
    expect((answer as { reason: string }).reason).toContain('terminating connection');
  });
});

describe('the answer never costs the check run', () => {
  it('does not throw for anything the reads can do', async () => {
    readStrict.mockRejectedValue('a string, not an Error');
    const answer = await contractAnswerForIssue(ISSUE_ID);
    expect(answer).toMatchObject({ kind: 'unreadable', reason: 'a string, not an Error' });
  });

  it('stamps every answer with the time it was computed', async () => {
    const before = Date.now();
    const judged = await contractAnswerForIssue(ISSUE_ID);
    standing = undefined;
    const unreadable = await contractAnswerForIssue(ISSUE_ID);
    for (const answer of [judged, unreadable]) {
      expect(answer.computedAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });
});

describe('which connection the reads run on', () => {
  it('runs the issue read and the criteria read on the executor it was given', async () => {
    const tx = { select } as never;
    await contractAnswerForIssue(ISSUE_ID, tx);
    expect(readStrict).toHaveBeenCalledWith(expect.objectContaining({ executor: tx }));
  });
});

describe('which contract this says it is', () => {
  it('names the declaration it reads, so nothing takes it for the plugin`s record ladder', () => {
    expect(CONTRACT_SOURCE).toContain('statusEntryCriteria');
    // The ladder's own vocabulary must not appear: `forge advance --owed` answers in record
    // kinds this package holds no copy of, and a body naming them would be a claim about a
    // contract nothing here read.
    expect(CONTRACT_SOURCE).not.toContain('confirmation');
    expect(CONTRACT_SOURCE).not.toContain('verdict');
  });
});
