import { beforeEach, describe, expect, it, vi } from 'vitest';

const listIssueCommentsMock = vi.fn(async (_issueId: string) => [] as Array<{ body: string }>);
vi.mock('../comments/service.js', () => ({
  listIssueComments: (issueId: string) => listIssueCommentsMock(issueId),
}));

interface IssueRow {
  id: string;
  acceptanceCriteria: string | null;
}
let issueRows: IssueRow[] = [];
const whereMock = vi.fn(async () => issueRows);
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn((_arg: unknown) => ({ from: fromMock }));
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const {
  acceptanceCriteriaNumbers,
  verdictPairsIn,
  latestCriterionVerdicts,
  issuesWithUnearnedCriteria,
} = await import('./criteria-verdicts.js');

beforeEach(() => {
  listIssueCommentsMock.mockReset();
  listIssueCommentsMock.mockResolvedValue([]);
  issueRows = [];
});

describe('acceptanceCriteriaNumbers', () => {
  it('reads the numbered top-level lines', () => {
    const text = '1. First outcome.\n2. Second outcome.\n10. Tenth outcome.';
    expect(acceptanceCriteriaNumbers(text)).toEqual([1, 2, 10]);
  });

  it('does not mint a number from an indented continuation line', () => {
    const text =
      '1. First outcome spanning\n   a wrapped second line that starts "2. not a criterion".';
    expect(acceptanceCriteriaNumbers(text)).toEqual([1]);
  });

  it('is empty for null or blank text', () => {
    expect(acceptanceCriteriaNumbers(null)).toEqual([]);
    expect(acceptanceCriteriaNumbers('')).toEqual([]);
  });
});

/** One criterion's verdict block, in the exact shape the CLI's `forge record verdict` writes. */
function verdictBlock(criterion: number, text: string, verdict: string): string {
  return [
    `criterion: ${criterion} — ${text}`,
    `verdict: ${verdict}`,
    'commit: dce6f354c',
    'evidence: judge-evidence.txt',
    'why: exercised directly',
    'judge: judge-1',
    'judge-from: inherited',
  ].join('\n');
}

function verdictComment(blocks: string[]): string {
  return [
    '## Judged',
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
}

describe('verdictPairsIn', () => {
  it('reads every criterion/verdict pair out of one fence, ISS-1114-shaped', () => {
    const body = verdictComment([
      verdictBlock(12, 'The session config gains no forge entry.', 'pass'),
      verdictBlock(13, 'The daemon log carries the three-way verdict.', 'skipped'),
    ]);
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 12, verdict: 'pass' },
      { criterion: 13, verdict: 'skipped' },
    ]);
  });

  it('reads nothing out of a non-verdict record', () => {
    const body = [
      '```forge-record',
      'is: something else',
      '```',
      '`forge-record: confirmation · contract 1`',
    ].join('\n');
    expect(verdictPairsIn(body)).toEqual([]);
  });

  it('reads nothing out of plain prose with no fence', () => {
    expect(verdictPairsIn('just a comment, no record here')).toEqual([]);
  });
});

describe('latestCriterionVerdicts', () => {
  it('lets a later comment supersede an earlier verdict for the same criterion', async () => {
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(16, 'close loop sends the project id', 'skipped')]) },
      { body: verdictComment([verdictBlock(16, 'close loop sends the project id', 'pass')]) },
    ]);
    const latest = await latestCriterionVerdicts('iss-1139');
    expect(latest.get(16)).toBe('pass');
  });

  it('keeps criteria untouched by a later comment at their earlier verdict', async () => {
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'pass')]) },
      { body: verdictComment([verdictBlock(1, 'a', 'pass')]) },
    ]);
    const latest = await latestCriterionVerdicts('iss-x');
    expect(latest.get(2)).toBe('pass');
  });
});

describe('issuesWithUnearnedCriteria', () => {
  it('names an issue holding a `skipped` criterion — the ISS-1139 shape', async () => {
    issueRows = [
      {
        id: 'iss-1139',
        acceptanceCriteria: Array.from({ length: 20 }, (_, i) => `${i + 1}. ok`).join('\n'),
      },
    ];
    const blocks = Array.from({ length: 19 }, (_, i) => verdictBlock(i + 1, 'ok', 'pass'));
    blocks.push(verdictBlock(20, 'the runner close loop', 'skipped'));
    listIssueCommentsMock.mockResolvedValueOnce([{ body: verdictComment(blocks) }]);

    expect(await issuesWithUnearnedCriteria(['iss-1139'])).toEqual(['iss-1139']);
  });

  it('drops an issue once its skipped criterion is later corrected to pass', async () => {
    issueRows = [{ id: 'iss-1139', acceptanceCriteria: '1. ok\n2. ok' }];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'skipped')]) },
      { body: verdictComment([verdictBlock(2, 'b', 'pass')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-1139'])).toEqual([]);
  });

  it('treats `fail` the same as `skipped` — not earned', async () => {
    issueRows = [{ id: 'iss-fail', acceptanceCriteria: '1. ok' }];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'fail')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-fail'])).toEqual(['iss-fail']);
  });

  it('treats a criterion never verdicted at all as not earned', async () => {
    issueRows = [{ id: 'iss-unjudged', acceptanceCriteria: '1. ok\n2. ok' }];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-unjudged'])).toEqual(['iss-unjudged']);
  });

  it('treats `short` as earned', async () => {
    issueRows = [{ id: 'iss-short', acceptanceCriteria: '1. ok' }];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'short')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-short'])).toEqual([]);
  });

  it('names every fully-pass issue as none — an empty roster check', async () => {
    expect(await issuesWithUnearnedCriteria([])).toEqual([]);
  });
});
