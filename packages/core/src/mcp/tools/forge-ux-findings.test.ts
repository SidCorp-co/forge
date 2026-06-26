import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// Drizzle mock chain — same shape as forge-feedback.test.ts.
// effectiveProjectRole: select().from().leftJoin().leftJoin().where().limit()
// resolveActiveJobContext: select().from().innerJoin().where().limit()
// count / ruleId / list: select().from().where()[.orderBy()].limit()
const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({
  where: selectWhere,
  leftJoin: selectLeftJoin,
  innerJoin: selectInnerJoin,
}));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../../db/client.js', () => ({
  db: { select: dbSelect, insert: dbInsert },
}));

const { forgeUxFindingsTool } = await import('./forge-ux-findings.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_SLUG = 'forge-dev';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const ISSUE_ID = '77777777-7777-4777-8777-777777777777';
const RULE_ID = '88888888-8888-4888-8888-888888888888';

const ORG_ID = '99999999-9999-4999-8999-999999999999';
const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  disabledAt: null,
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function makeCtx(projectSlug = PROJECT_SLUG) {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  selectFrom.mockImplementation(() => ({
    where: selectWhere,
    leftJoin: selectLeftJoin,
    innerJoin: selectInnerJoin,
  }));
  selectWhere.mockImplementation(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  selectLeftJoin.mockImplementation(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
  selectLeftJoin2.mockImplementation(() => ({ where: selectWhere }));
  selectInnerJoin.mockImplementation(() => ({ where: selectWhere }));
  insertValues.mockImplementation(() => ({ returning: insertReturning }));
  dbSelect.mockImplementation(() => ({ from: selectFrom }));
  dbInsert.mockImplementation(() => ({ values: insertValues }));
});

describe('forge_ux_findings write', () => {
  it('happy path: resolves issue/run from active job and inserts', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdFromSlug
    selectLimit.mockResolvedValueOnce([memberAccessRow]); // assertPrincipalIsWriter
    selectLimit.mockResolvedValueOnce([{ jobId: JOB_ID, runId: RUN_ID, issueId: ISSUE_ID }]); // active job
    selectLimit.mockResolvedValueOnce([{ n: 0 }]); // per-job count
    insertReturning.mockResolvedValueOnce([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);

    const result = await tool.handler({
      action: 'write',
      stage: 'review',
      kind: 'missing-state',
      detail: 'Empty-search state is not implemented for the bindings list',
    });

    expect(result).toMatchObject({ ok: true, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const inserted = (insertValues.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(inserted.issueId).toBe(ISSUE_ID);
    expect(inserted.runId).toBe(RUN_ID);
    expect(inserted.stage).toBe('review');
    expect(inserted.kind).toBe('missing-state');
    expect(inserted.severity).toBe('must');
  });

  it('drops a ruleId that does not belong to the project', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ jobId: JOB_ID, runId: RUN_ID, issueId: ISSUE_ID }]);
    selectLimit.mockResolvedValueOnce([{ n: 0 }]);
    selectLimit.mockResolvedValueOnce([]); // ruleId lookup → not found in project
    insertReturning.mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);

    await tool.handler({
      action: 'write',
      stage: 'review',
      kind: 'a11y',
      detail: 'No visible focus ring on the primary action',
      ruleId: RULE_ID,
    });

    const inserted = (insertValues.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect(inserted.ruleId).toBeUndefined();
  });

  it('soft-rejects with no_active_issue when no issue-bound job is running', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([]); // no active job

    const result = await tool.handler({
      action: 'write',
      stage: 'verify-live',
      kind: 'responsive',
      detail: 'Layout breaks at 375px',
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_active_issue' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('soft-rejects with rate_limited at the per-job cap', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([{ jobId: JOB_ID, runId: RUN_ID, issueId: ISSUE_ID }]);
    selectLimit.mockResolvedValueOnce([{ n: 50 }]); // at cap

    const result = await tool.handler({
      action: 'write',
      stage: 'review',
      kind: 'other',
      detail: 'Over the cap',
    });

    expect(result).toMatchObject({ ok: false, reason: 'rate_limited', limit: 50 });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('missing required field throws BAD_REQUEST', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool.handler({ action: 'write', kind: 'missing-state', detail: 'x' }),
    ).rejects.toThrow('stage is required');
  });
});

describe('forge_ux_findings list', () => {
  const baseFinding = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    issueId: ISSUE_ID,
    runId: RUN_ID,
    stage: 'review',
    ruleId: null,
    kind: 'missing-state',
    detail: 'Missing empty state',
    severity: 'must',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('returns findings filtered by issueId', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([baseFinding]);

    const result = (await tool.handler({
      action: 'list',
      filters: { issueId: ISSUE_ID },
    })) as { findings: unknown[] };

    expect(result.findings).toHaveLength(1);
  });

  it('wraps the detail field in markUntrusted framing', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([baseFinding]);

    const result = (await tool.handler({ action: 'list' })) as {
      findings: Array<Record<string, string>>;
    };

    expect(result.findings[0]?.detail).toContain('UNTRUSTED_DATA');
  });

  it('returns empty array when no findings match', async () => {
    const tool = forgeUxFindingsTool(makeCtx());

    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([]);

    const result = (await tool.handler({ action: 'list' })) as { findings: unknown[] };
    expect(result.findings).toEqual([]);
    expect(result).not.toHaveProperty('truncated');
  });
});
