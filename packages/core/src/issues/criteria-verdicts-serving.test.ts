/**
 * ISS-1286 — a runtime verdict against a reading of what the project is serving.
 *
 * The scaffolding mirrors `criteria-verdicts.test.ts`: the comment read and the issue row read are
 * the only two the module makes, and both are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingReading } from '../release-batch/serving-reading.js';

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
let heldNames: string[] = [];
const selectMock = vi.fn((arg: unknown) => {
  const columns = (arg ?? {}) as Record<string, unknown>;
  const rows = async () => ('id' in columns ? issueRows : heldNames.map((name) => ({ name })));
  const where = vi.fn(rows);
  return { from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })) };
});
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const { issuesWithUnearnedCriteria, unearnedCriteriaReports } = await import(
  './criteria-verdicts.js'
);

const SOURCE = 'dce6f354c727baa81c681f144cbadf30050eabfc';
const READ_AT = '2026-09-26T23:55:00.000Z';
const UNDECLARED: ServingReading = { kind: 'undeclared' };

function verdictBlock(criterion: number, verdict: string, runtime: string): string {
  return [
    `criterion: ${criterion} — a`,
    `verdict: ${verdict}`,
    `runtime: ${runtime}`,
    'evidence: judge-evidence.txt',
    'judge: judge-1',
  ].join('\n');
}

function verdictComment(blocks: string[]): string {
  return ['```forge-record', ...blocks, '```', '', '`forge-record: verdict · contract 1`'].join(
    '\n',
  );
}

beforeEach(() => {
  listIssueCommentsMock.mockReset();
  listIssueCommentsMock.mockResolvedValue([]);
  issueRows = [];
  heldNames = ['judge-evidence.txt'];
});

/**
 * The sid-desk board, in one issue: `landing.deployment` names `da74b598` and the host answers
 * `0d98a6be`, its descendant. Eight issues were judged at what the host answered and every one was
 * refused against the stored ancestor.
 */
describe('a runtime verdict against what the host answers (ISS-1286)', () => {
  const STORED_ANCESTOR = 'da74b598bcae5a53a1c0f2b9e3d7a41f6c8b2d90';
  const SERVED_HEAD = '0d98a6be6d9680b967d3f16542eadd25d02602cb';
  const SERVED: ServingReading = {
    kind: 'serving',
    commits: [SERVED_HEAD],
    unread: [],
    hosts: ['https://helpdesk-api.musetools.com/api/build-info'],
    readAt: READ_AT,
  };

  /** ISS-546's own shape: a stored deployment one commit behind what the host answers. */
  const stale = (id: string): IssueRow => ({
    id,
    acceptanceCriteria: '1. ok',
    sessionContext: { landing: { head: SOURCE, deployment: STORED_ANCESTOR } },
    mergedCommitSha: null,
  });

  // Not `...Once`: one test reads the same issue twice, and the second read must see the verdict.
  const judgedAt = (runtime: string) =>
    listIssueCommentsMock.mockResolvedValue([
      { body: verdictComment([verdictBlock(1, 'pass', runtime)]) },
    ]);

  it('earns the criterion the host answers, whatever the issue stored', async () => {
    issueRows = [stale('iss-546')];
    judgedAt(SERVED_HEAD);
    const [report] = await unearnedCriteriaReports(['iss-546'], SERVED);
    expect(report?.unearned).toEqual([]);
  });

  it('refuses the criterion judged at the commit the issue stored, which nothing serves', async () => {
    issueRows = [stale('iss-546')];
    judgedAt(STORED_ANCESTOR);
    const [report] = await unearnedCriteriaReports(['iss-546'], SERVED);
    expect(report?.unearned[0]?.standing).toBe('superseded');
    expect(report?.unearned[0]?.why).toContain(SERVED_HEAD);
    expect(report?.unearned[0]?.why).toContain('https://helpdesk-api.musetools.com/api/build-info');
    expect(report?.unearned[0]?.why).toContain(READ_AT);
  });

  it('earns it where the project declares no way to ask, and says the verdict is uncorroborated', async () => {
    issueRows = [stale('iss-526')];
    judgedAt(SERVED_HEAD);
    const [report] = await unearnedCriteriaReports(['iss-526'], UNDECLARED);
    expect(report?.unearned).toEqual([]);
    expect(report?.uncorroborated).toEqual([1]);
  });

  it('earns it where the declared host answered nothing, and does not hold the issue', async () => {
    issueRows = [stale('iss-547')];
    judgedAt(SERVED_HEAD);
    const down: ServingReading = {
      kind: 'unreadable',
      why: 'https://helpdesk-api.musetools.com/api/build-info is unreachable (ECONNREFUSED)',
      hosts: ['https://helpdesk-api.musetools.com/api/build-info'],
      readAt: READ_AT,
    };
    const [report] = await unearnedCriteriaReports(['iss-547'], down);
    expect(report?.unearned).toEqual([]);
    expect(report?.uncorroborated).toEqual([1]);
    expect(await issuesWithUnearnedCriteria(['iss-547'], down)).toEqual([]);
  });

  // ISS-1286 F3 — one probe answering beside one that failed refuses a verdict naming neither.
  it('refuses a verdict against a fleet where one probe answered and another failed', async () => {
    issueRows = [stale('iss-543')];
    judgedAt(SERVED_HEAD);
    const partly: ServingReading = {
      kind: 'serving',
      commits: [STORED_ANCESTOR],
      unread: ['https://two.test/h is unreachable (ECONNREFUSED)'],
      hosts: ['https://one.test/h', 'https://two.test/h'],
      readAt: READ_AT,
    };
    const [report] = await unearnedCriteriaReports(['iss-543'], partly);
    expect(report?.unearned[0]?.standing).toBe('superseded');
    expect(report?.uncorroborated).toEqual([]);
  });

  it('names no criterion uncorroborated where the reading answered a commit', async () => {
    issueRows = [stale('iss-546')];
    judgedAt(SERVED_HEAD);
    const [report] = await unearnedCriteriaReports(['iss-546'], SERVED);
    expect(report?.uncorroborated).toEqual([]);
  });

  it('leaves a criterion unearned on its own word uncorroborated-free, whatever the reading', async () => {
    issueRows = [stale('iss-548')];
    listIssueCommentsMock.mockResolvedValue([
      { body: verdictComment([verdictBlock(1, 'fail', SERVED_HEAD)]) },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-548'], UNDECLARED);
    expect(report?.unearned[0]?.why).toContain('not earned');
    expect(report?.uncorroborated).toEqual([]);
  });

  it('refuses a verdict a disagreeing fleet answered neither commit of', async () => {
    issueRows = [stale('iss-543')];
    judgedAt(SERVED_HEAD);
    const rollout: ServingReading = {
      kind: 'serving',
      commits: [STORED_ANCESTOR, '9999999999999999999999999999999999999999'],
      unread: [],
      hosts: ['https://one.test/h', 'https://two.test/h'],
      readAt: READ_AT,
    };
    const [report] = await unearnedCriteriaReports(['iss-543'], rollout);
    expect(report?.unearned[0]?.standing).toBe('superseded');
    expect(report?.uncorroborated).toEqual([]);
  });

  it('earns a verdict naming one of the commits a disagreeing fleet answered', async () => {
    issueRows = [stale('iss-543')];
    judgedAt(SERVED_HEAD);
    const rollout: ServingReading = {
      kind: 'serving',
      commits: [STORED_ANCESTOR, SERVED_HEAD],
      unread: [],
      hosts: ['https://one.test/h', 'https://two.test/h'],
      readAt: READ_AT,
    };
    const [report] = await unearnedCriteriaReports(['iss-543'], rollout);
    expect(report?.unearned).toEqual([]);
  });
});
