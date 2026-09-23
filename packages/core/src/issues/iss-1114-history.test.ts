/**
 * ISS-1114's own verdict history, the reproduction ISS-1187 is measured against.
 *
 * Five verdict records, two identities, and not one of them names a runtime. Criterion 13 was
 * `skipped` at 06fa37c6d at 19:33 and `pass` at dce6f354c at 21:41 — two judgements of two
 * different things, decided by recency alone — and for roughly 32 hours the issue read as fully
 * earned. The correction of 2026-09-22 is the last record here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listIssueCommentsMock = vi.fn(async (_issueId: string) => [] as Array<{ body: string }>);
vi.mock('../comments/service.js', () => ({
  listIssueComments: (issueId: string) => listIssueCommentsMock(issueId),
}));

interface IssueRow {
  id: string;
  acceptanceCriteria: string | null;
  sessionContext: unknown;
  mergedCommitSha: string | null;
}
let issueRows: IssueRow[] = [];
const whereMock = vi.fn(async () => issueRows);
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn((_arg: unknown) => ({ from: fromMock }));
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const { unearnedCriteriaReports, issuesWithUnearnedCriteria } = await import(
  './criteria-verdicts.js'
);

/** The head `forge claim --pushed` captured on ISS-1114, which is all the issue records. */
const LANDING_HEAD = 'dce6f354c727baa81c681f144cbadf30050eabfc';

const CRITERIA = Array.from({ length: 13 }, (_, i) => `${i + 1}. Criterion ${i + 1}.`).join('\n');

function record(blocks: string[]): string {
  return [
    '## Verdict',
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
}

function block(criterion: number, verdict: string, commit: string): string {
  return [
    `criterion: ${criterion} — Criterion ${criterion}.`,
    `verdict: ${verdict}`,
    `commit: ${commit}`,
    'evidence: daemon1.log',
    'judge: qa-judge-1114-verdicts',
    'judge-from: asked',
  ].join('\n');
}

const batch = (to: number, verdict: string, commit: string, last?: string): string =>
  record(
    Array.from({ length: to }, (_, i) =>
      block(i + 1, i + 1 === to && last ? last : verdict, commit),
    ),
  );

/** Every comment on ISS-1114 that parses as a verdict, in the order they were posted. */
const BEFORE_THE_CORRECTION: Array<{ body: string }> = [
  { body: batch(13, 'pass', 'dce6f354c', 'skipped') },
  { body: batch(12, 'pass', '06fa37c6d') },
  { body: record([block(13, 'skipped', '06fa37c6d')]) },
  { body: batch(13, 'pass', 'dce6f354c') },
  { body: '## Verification\n\nCRITERION 13 STILL STANDS SKIPPED.' },
];

const THE_CORRECTION = {
  body: record([block(13, 'skipped', '06fa37c6dfbc841bd75c3898034a53a1529a9c74')]),
};

beforeEach(() => {
  listIssueCommentsMock.mockReset();
  issueRows = [
    {
      id: 'iss-1114',
      acceptanceCriteria: CRITERIA,
      sessionContext: { landing: { head: LANDING_HEAD, base: 'ab8e2f13', state: 'done' } },
      mergedCommitSha: null,
    },
  ];
});

describe("ISS-1114's history before the 2026-09-22 correction", () => {
  beforeEach(() => {
    listIssueCommentsMock.mockResolvedValue(BEFORE_THE_CORRECTION);
  });

  it('reports the issue as carrying unearned criteria', async () => {
    expect(await issuesWithUnearnedCriteria(['iss-1114'])).toEqual(['iss-1114']);
  });

  it('names all thirteen, each judged against a source no runtime witnessed', async () => {
    const [report] = await unearnedCriteriaReports(['iss-1114']);
    expect(report?.unearned.map((c) => c.criterion)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(report?.unearned.every((c) => c.standing === 'unwitnessed')).toBe(true);
    expect(report?.unearned[12]?.why).toContain('no runtime witnessed it');
  });

  it('reads criterion 13 as the pass that superseded the skipped one by recency alone', async () => {
    const [report] = await unearnedCriteriaReports(['iss-1114']);
    expect(report?.unearned[12]).toMatchObject({ criterion: 13, verdict: 'pass' });
  });
});

describe("ISS-1114's history including the correction", () => {
  beforeEach(() => {
    listIssueCommentsMock.mockResolvedValue([...BEFORE_THE_CORRECTION, THE_CORRECTION]);
  });

  it('gives criterion 13 the verdict word the correction wrote', async () => {
    const [report] = await unearnedCriteriaReports(['iss-1114']);
    expect(report?.unearned[12]).toMatchObject({ criterion: 13, verdict: 'skipped' });
    expect(report?.unearned[12]?.why).toContain('not earned');
  });
});

describe('the same history on an issue that records a serving runtime', () => {
  it('stands only where the verdict names that runtime', async () => {
    const serving = '33637c612ef15be6f924520c0d201a0889d8ed7e';
    issueRows = [
      {
        id: 'iss-1114',
        acceptanceCriteria: '1. Criterion 1.',
        sessionContext: { landing: { head: LANDING_HEAD, deployment: serving } },
        mergedCommitSha: null,
      },
    ];
    listIssueCommentsMock.mockResolvedValue([
      {
        body: record([
          [
            'criterion: 1 — Criterion 1.',
            'verdict: pass',
            `runtime: ${serving}`,
            'judge: qa-judge',
          ].join('\n'),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-1114']);
    expect(report?.unearned).toEqual([]);
  });
});
