import { beforeEach, describe, expect, it, vi } from 'vitest';

const listIssueCommentsMock = vi.fn(async (_issueId: string) => [] as Array<{ body: string }>);
vi.mock('../comments/service.js', () => ({
  listIssueComments: (issueId: string) => listIssueCommentsMock(issueId),
}));

interface IssueRow {
  id: string;
  acceptanceCriteria: string | null;
  sessionContext?: unknown;
  mergedCommitSha?: string | null;
}
let issueRows: IssueRow[] = [];
/** The names the tracker holds attachments under, for the issue under test. */
let heldNames: string[] = [];
/** The issue read selects `id`; the two attachment reads select `name`. */
const selectMock = vi.fn((arg: unknown) => {
  const columns = (arg ?? {}) as Record<string, unknown>;
  const rows = async () => ('id' in columns ? issueRows : heldNames.map((name) => ({ name })));
  const where = vi.fn(rows);
  return { from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })) };
});
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const {
  acceptanceCriteriaNumbers,
  verdictPairsIn,
  latestCriterionVerdicts,
  issuesWithUnearnedCriteria,
  unearnedCriteriaReports,
} = await import('./criteria-verdicts.js');

/** The identity the issues in this file record as serving them. */
const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const SOURCE = 'dce6f354c727baa81c681f144cbadf30050eabfc';

/** An issue that records a serving runtime, so a verdict naming it can stand. */
const deployed = (id: string, acceptanceCriteria: string | null): IssueRow => ({
  id,
  acceptanceCriteria,
  sessionContext: { landing: { head: SOURCE, deployment: SERVING } },
  mergedCommitSha: null,
});

beforeEach(() => {
  listIssueCommentsMock.mockReset();
  listIssueCommentsMock.mockResolvedValue([]);
  issueRows = [];
  heldNames = ['judge-evidence.txt'];
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
function verdictBlock(
  criterion: number,
  text: string,
  verdict: string,
  { runtime = SERVING, commit }: { runtime?: string | null; commit?: string | null } = {},
): string {
  return [
    `criterion: ${criterion} — ${text}`,
    `verdict: ${verdict}`,
    ...(runtime ? [`runtime: ${runtime}`] : []),
    ...(commit ? [`commit: ${commit}`] : []),
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

/** What every block `verdictBlock` writes cites, which is one attachment name. */
const CITED = ['judge-evidence.txt'];

describe('verdictPairsIn', () => {
  it('reads every criterion, verdict and identity out of one fence, ISS-1114-shaped', () => {
    const body = verdictComment([
      verdictBlock(12, 'The session config gains no forge entry.', 'pass'),
      verdictBlock(13, 'The daemon log carries the three-way verdict.', 'skipped'),
    ]);
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 12, verdict: 'pass', at: { kind: 'runtime', value: SERVING }, cited: CITED },
      { criterion: 13, verdict: 'skipped', at: { kind: 'runtime', value: SERVING }, cited: CITED },
    ]);
  });

  it('reads a commit as a source identity where no runtime is named', () => {
    const body = verdictComment([
      verdictBlock(1, 'a', 'pass', { runtime: null, commit: 'dce6f354c' }),
    ]);
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 1, verdict: 'pass', at: { kind: 'source', value: 'dce6f354c' }, cited: CITED },
    ]);
  });

  it('names no identity where the block carries neither field', () => {
    const body = verdictComment([verdictBlock(1, 'a', 'pass', { runtime: null })]);
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 1, verdict: 'pass', at: null, cited: CITED },
    ]);
  });

  it('prefers the runtime where a block carries both', () => {
    const body = verdictComment([verdictBlock(1, 'a', 'pass', { commit: 'dce6f354c' })]);
    expect(verdictPairsIn(body)[0]?.at).toEqual({ kind: 'runtime', value: SERVING });
  });

  it('gives an identity written after the next criterion line to that later criterion', () => {
    const body = verdictComment([
      ['criterion: 1 — a', 'verdict: pass'].join('\n'),
      ['criterion: 2 — b', 'verdict: pass', `runtime: ${SERVING}`].join('\n'),
    ]);
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 1, verdict: 'pass', at: null, cited: [] },
      { criterion: 2, verdict: 'pass', at: { kind: 'runtime', value: SERVING }, cited: [] },
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

  it('reads a verdict whose tag is carried on the fence itself', () => {
    const body = [
      '## Judged',
      '',
      '```forge-record: verdict · contract 1',
      verdictBlock(13, 'The daemon log carries the three-way verdict.', 'pass'),
      '```',
    ].join('\n');
    expect(verdictPairsIn(body)).toEqual([
      { criterion: 13, verdict: 'pass', at: { kind: 'runtime', value: SERVING }, cited: CITED },
    ]);
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
    expect(latest.get(16)?.verdict).toBe('pass');
  });

  it('keeps criteria untouched by a later comment at their earlier verdict', async () => {
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'pass')]) },
      { body: verdictComment([verdictBlock(1, 'a', 'pass')]) },
    ]);
    const latest = await latestCriterionVerdicts('iss-x');
    expect(latest.get(2)?.verdict).toBe('pass');
  });
});

describe('issuesWithUnearnedCriteria', () => {
  it('names an issue holding a `skipped` criterion — the ISS-1139 shape', async () => {
    issueRows = [
      deployed('iss-1139', Array.from({ length: 20 }, (_, i) => `${i + 1}. ok`).join('\n')),
    ];
    const blocks = Array.from({ length: 19 }, (_, i) => verdictBlock(i + 1, 'ok', 'pass'));
    blocks.push(verdictBlock(20, 'the runner close loop', 'skipped'));
    listIssueCommentsMock.mockResolvedValueOnce([{ body: verdictComment(blocks) }]);

    expect(await issuesWithUnearnedCriteria(['iss-1139'])).toEqual(['iss-1139']);
  });

  it('drops an issue once its skipped criterion is later corrected to pass', async () => {
    issueRows = [deployed('iss-1139', '1. ok\n2. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass'), verdictBlock(2, 'b', 'skipped')]) },
      { body: verdictComment([verdictBlock(2, 'b', 'pass')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-1139'])).toEqual([]);
  });

  it('treats `fail` the same as `skipped` — not earned', async () => {
    issueRows = [deployed('iss-fail', '1. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'fail')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-fail'])).toEqual(['iss-fail']);
  });

  it('treats a criterion never verdicted at all as not earned', async () => {
    issueRows = [deployed('iss-unjudged', '1. ok\n2. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-unjudged'])).toEqual(['iss-unjudged']);
  });

  it('treats `short` as earned', async () => {
    issueRows = [deployed('iss-short', '1. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'short')]) },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-short'])).toEqual([]);
  });

  it('names an issue whose pass was judged at a runtime it no longer stands at', async () => {
    issueRows = [deployed('iss-repaired', '1. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: verdictComment([
          verdictBlock(1, 'a', 'pass', { runtime: '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51' }),
        ]),
      },
    ]);
    expect(await issuesWithUnearnedCriteria(['iss-repaired'])).toEqual(['iss-repaired']);
  });

  it('names every fully-pass issue as none — an empty roster check', async () => {
    expect(await issuesWithUnearnedCriteria([])).toEqual([]);
  });
});

describe('unearnedCriteriaReports', () => {
  it('names the criterion, its verdict word, its standing and why for a superseded pass', async () => {
    issueRows = [deployed('iss-repaired', '1. ok')];
    const stale = '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51';
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass', { runtime: stale })]) },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-repaired']);
    expect(report?.unearned).toEqual([
      {
        criterion: 1,
        verdict: 'pass',
        standing: 'superseded',
        why: `judged at ${stale}, and this issue now stands at ${SERVING}`,
      },
    ]);
  });

  it('carries no verdict word and no standing for a criterion nothing ever judged', async () => {
    issueRows = [deployed('iss-unjudged', '1. ok')];
    const [report] = await unearnedCriteriaReports(['iss-unjudged']);
    expect(report?.unearned).toEqual([
      { criterion: 1, verdict: null, standing: null, why: 'no verdict was recorded for it' },
    ]);
  });

  it('says a standing verdict is not earned on its own word, not on its identity', async () => {
    issueRows = [deployed('iss-1139', '1. ok')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'skipped')]) },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-1139']);
    expect(report?.unearned[0]).toMatchObject({
      standing: 'stands',
      why: expect.stringContaining('not earned'),
    });
  });

  it('reports an issue with no numbered criteria as owing nothing', async () => {
    issueRows = [deployed('iss-no-criteria', 'prose with no numbered line')];
    expect(await unearnedCriteriaReports(['iss-no-criteria'])).toEqual([
      { issueId: 'iss-no-criteria', unearned: [], broken: [], serving: SERVING },
    ]);
  });

  it('carries the deployment the issue records as serving it, or null where it records none', async () => {
    issueRows = [
      deployed('iss-served', '1. ok'),
      {
        id: 'iss-unserved',
        acceptanceCriteria: '1. ok',
        sessionContext: {},
        mergedCommitSha: SOURCE,
      },
    ];
    const reports = await unearnedCriteriaReports(['iss-served', 'iss-unserved']);
    expect(reports.map((r) => [r.issueId, r.serving])).toEqual([
      ['iss-served', SERVING],
      ['iss-unserved', null],
    ]);
  });

  it('returns the same issue ids issuesWithUnearnedCriteria does', async () => {
    issueRows = [deployed('iss-a', '1. ok'), deployed('iss-b', '1. ok')];
    listIssueCommentsMock.mockImplementation(async (id: string) =>
      id === 'iss-a' ? [{ body: verdictComment([verdictBlock(1, 'a', 'pass')]) }] : [],
    );
    const reports = await unearnedCriteriaReports(['iss-a', 'iss-b']);
    expect(reports.filter((r) => r.unearned.length > 0).map((r) => r.issueId)).toEqual(['iss-b']);
    expect(await issuesWithUnearnedCriteria(['iss-a', 'iss-b'])).toEqual(['iss-b']);
  });
});

describe('what a verdict cites, once the evidence is gone', () => {
  /** The incident: a verdict citing a capture the run wrote, and the capture destroyed. */
  const judged = (verdict = 'pass') =>
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'the screen cleared', verdict)]) },
    ]);

  it('leaves an earned, standing verdict alone while the tracker holds what it cites', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    judged();
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.unearned).toEqual([]);
    expect(report?.broken).toEqual([]);
  });

  it('stops an earned, standing verdict reading as earned once what it cites is gone', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    judged();
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.unearned).toEqual([
      {
        criterion: 1,
        verdict: 'pass',
        standing: 'stands',
        why: 'its evidence does not resolve: `judge-evidence.txt` names no attachment this issue holds',
      },
    ]);
  });

  it('names the criterion and the citation beside the unearned list', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    judged();
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.broken).toEqual([
      { criterion: 1, unresolved: [{ cited: 'judge-evidence.txt', standing: 'dangling' }] },
    ]);
  });

  it('carries the runtime reason and the citation reason where both hold', async () => {
    const stale = 'ffffffffffffffffffffffffffffffffffffffff';
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([verdictBlock(1, 'a', 'pass', { runtime: stale })]) },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.unearned[0]?.why).toContain(`judged at ${stale}`);
    expect(report?.unearned[0]?.why).toContain('does not resolve');
  });

  it('carries the verdict-word reason and the citation reason where both hold', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    judged('fail');
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.unearned[0]?.why).toContain('not earned');
    expect(report?.unearned[0]?.why).toContain('does not resolve');
  });

  it('reports a criterion whose citation is gone through issuesWithUnearnedCriteria too', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    judged();
    expect(await issuesWithUnearnedCriteria(['iss-497'])).toEqual(['iss-497']);
  });

  it('leaves a citation pointing outside the tracker alone, and says it was not followed', async () => {
    issueRows = [deployed('iss-653', '1. ok')];
    heldNames = [];
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: verdictComment([
          [
            'criterion: 1 — a',
            'verdict: pass',
            `runtime: ${SERVING}`,
            'evidence: https://example.test/run.log',
            'evidence: packages/core/src/ws/server.test.ts',
            'evidence: afd83c9a4',
          ].join('\n'),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-653']);
    expect(report?.unearned).toEqual([]);
    expect(report?.broken).toEqual([]);
  });

  it('reports a citation written as a path on the writing machine as unreachable', async () => {
    issueRows = [deployed('iss-497', '1. ok')];
    heldNames = [];
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: verdictComment([
          [
            'criterion: 1 — a',
            'verdict: pass',
            `runtime: ${SERVING}`,
            'evidence: /tmp/claude-1000/scratchpad/c17-cleared.png',
          ].join('\n'),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.broken[0]?.unresolved).toEqual([
      { cited: '/tmp/claude-1000/scratchpad/c17-cleared.png', standing: 'unreachable' },
    ]);
    expect(report?.unearned[0]?.why).toContain('the tracker never held');
  });

  it('reports every criterion whose citation is gone, not only the first', async () => {
    issueRows = [deployed('iss-497', '1. ok\n2. ok\n3. ok')];
    heldNames = [];
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: verdictComment([
          verdictBlock(1, 'a', 'pass'),
          verdictBlock(2, 'b', 'pass'),
          verdictBlock(3, 'c', 'pass'),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-497']);
    expect(report?.broken.map((b) => b.criterion)).toEqual([1, 2, 3]);
  });
});
