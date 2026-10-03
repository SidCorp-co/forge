/**
 * ISS-1286 — a runtime verdict against a reading of what the project is serving.
 *
 * The scaffolding mirrors `criteria-verdicts.test.ts`: the comment read and the issue row read are
 * the only two the module makes, and both are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingReading } from '../release-batch/serving-reading.js';

const listIssueCommentsMock = vi.fn(async (_issueId: string) => [] as Array<{ body: string }>);
// The criteria store reads the issue's criteria text and each mocked comment body as the rows they
// would have written (ISS-55, `criteria/store.fixture.ts`).
vi.mock('./criteria/store.js', async () => {
  const { criteriaOfText } = await import('./criteria/store.fixture.js');
  return {
    listCriteria: async (_executor: unknown, issueId: string) =>
      criteriaOfText(
        issueRows.find((row) => row.id === issueId)?.acceptanceCriteria ?? null,
        (await listIssueCommentsMock(issueId)).map((row) => row.body),
      ),
  };
});

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
const UNDECLARED: ServingReading = {
  kind: 'undeclared',
  missing:
    'this project has no active deploy binding, so Forge makes no deployment it could read a commit from',
  route:
    'bind a deploy binding Forge deploys through whose provider reports the commit a deployment built (Coolify does), or declare `verify.probes` on the live deploy binding',
};

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
    served: [{ commit: SERVED_HEAD, where: 'https://helpdesk-api.musetools.com/api/build-info' }],
    unread: [],
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
    expect(report?.unearned[0]?.why).toContain(
      `judged at ${STORED_ANCESTOR}, which is not a commit this project is serving`,
    );
    // What is served, where and when is the reading the report carries, said once by its writer
    // rather than inside each criterion's reason (ISS-1346, criterion 25).
    expect(report?.serving).toBe(SERVED);
    expect(report?.unearned[0]?.why).not.toContain(SERVED_HEAD);
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
      served: [{ commit: STORED_ANCESTOR, where: 'https://one.test/h' }],
      unread: ['https://two.test/h is unreachable (ECONNREFUSED)'],
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

  it('earns one criterion uncorroborated while another still holds the issue', async () => {
    issueRows = [{ ...stale('iss-548'), acceptanceCriteria: '1. ok\n2. also ok' }];
    listIssueCommentsMock.mockResolvedValue([
      {
        body: verdictComment([
          verdictBlock(1, 'pass', SERVED_HEAD),
          verdictBlock(2, 'fail', SERVED_HEAD),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-548'], UNDECLARED);
    expect(report?.uncorroborated).toEqual([1]);
    expect(report?.unearned.map((c) => c.criterion)).toEqual([2]);
  });

  it('refuses a verdict a disagreeing fleet answered neither commit of', async () => {
    issueRows = [stale('iss-543')];
    judgedAt(SERVED_HEAD);
    const rollout: ServingReading = {
      kind: 'serving',
      served: [
        { commit: STORED_ANCESTOR, where: 'https://one.test/h' },
        { commit: '9999999999999999999999999999999999999999', where: 'https://two.test/h' },
      ],
      unread: [],
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
      served: [
        { commit: STORED_ANCESTOR, where: 'https://one.test/h' },
        { commit: SERVED_HEAD, where: 'https://two.test/h' },
      ],
      unread: [],
      readAt: READ_AT,
    };
    const [report] = await unearnedCriteriaReports(['iss-543'], rollout);
    expect(report?.unearned).toEqual([]);
  });
});

/**
 * ISS-1346 criterion 25 — sid-desk ISS-536 spelled one commit `b7bb63bb98621e…` in one comment and
 * `b7bb63bb` in another, and its hold read them as two judged commits.
 */
describe('one judged commit, however it was spelled', () => {
  const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
  const JUDGED = '34450f4420ae4a3b6de40b6d3cfb2b0e66aa2f51';
  const LIVE: ServingReading = {
    kind: 'serving',
    served: [{ commit: SERVING, where: 'https://app.test/build-info' }],
    unread: [],
    readAt: READ_AT,
  };
  const row = (id: string): IssueRow => ({
    id,
    acceptanceCriteria: '1. ok\n2. ok',
    sessionContext: { landing: { head: SOURCE } },
    mergedCommitSha: null,
  });
  const sourceBlock = (criterion: number, commit: string) =>
    [`criterion: ${criterion} — a`, 'verdict: pass', `commit: ${commit}`].join('\n');

  it('names it by its longest spelling, in one reason', async () => {
    issueRows = [row('iss-spelled')];
    listIssueCommentsMock.mockResolvedValueOnce([
      { body: verdictComment([sourceBlock(1, JUDGED), sourceBlock(2, JUDGED.slice(0, 8))]) },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-spelled'], LIVE);
    expect(report?.unearned.map((c) => c.standing)).toEqual(['superseded', 'superseded']);
    expect(report?.unearned[1]?.why).toBe(report?.unearned[0]?.why);
    expect(report?.unearned[1]?.why).toContain(`judged at ${JUDGED},`);
  });

  // The respelling moves words only: a short runtime is compared exactly, and one that stands
  // beside it lends it no spelling that would say a served commit is not served.
  it('leaves a short runtime its own standing and spelling beside a whole one that stands', async () => {
    issueRows = [row('iss-short-runtime')];
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: verdictComment([
          verdictBlock(1, 'pass', SERVING),
          verdictBlock(2, 'pass', SERVING.slice(0, 8)),
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['iss-short-runtime'], LIVE);
    expect(report?.unearned.map((c) => [c.criterion, c.standing])).toEqual([[2, 'superseded']]);
    expect(report?.unearned[0]?.why).toContain(`judged at ${SERVING.slice(0, 8)},`);
  });
});
