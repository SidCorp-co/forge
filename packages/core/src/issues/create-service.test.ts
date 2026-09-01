/**
 * ISS-889 — the create path's own rules, tested where they now live rather
 * than through either transport.
 *
 * The ordering assertions are the load-bearing ones: `issueCreated`
 * synchronously wakes the dispatcher, so anything that must be visible to the
 * first tick has to land before it. Both transports used to own a copy of this
 * sequence and had already drifted on where attachments went.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const calls: string[] = [];

const insertReturning = vi.fn(async () => [{ ...ROW }]);
const txInsertValues = vi.fn(() => {
  const thenable: PromiseLike<unknown> & { returning: typeof insertReturning } = {
    returning: insertReturning,
    then: (resolve, reject) => Promise.resolve(undefined).then(resolve as never, reject as never),
  };
  return thenable;
});
const txInsert = vi.fn((_table?: unknown) => {
  calls.push('insert');
  return { values: txInsertValues };
});
const selectLimit = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) })),
    transaction: async (cb: (tx: { insert: typeof txInsert }) => Promise<unknown>) => {
      calls.push('tx:begin');
      const result = await cb({ insert: txInsert });
      calls.push('tx:commit');
      return result;
    },
  },
}));

const applyIntakeGateMock = vi.fn(async (_p: string, status: string) => ({
  status,
  gated: false,
}));
const finalizeIntakeMock = vi.fn(async () => undefined);
vi.mock('./intake-gate.js', () => ({
  applyIntakeGate: (p: string, s: string) => applyIntakeGateMock(p, s),
  finalizeIntake: () => finalizeIntakeMock(),
}));

const decodeMock = vi.fn((a: unknown[]) => a.map(() => ({ stub: true })));
const persistMock = vi.fn(async () => {
  calls.push('attachments');
  return { persisted: [{ id: 'att-1' }], errors: [] };
});
vi.mock('./attachment-service.js', () => ({
  decodeAndValidateAttachments: (a: unknown[]) => decodeMock(a),
  persistDecodedIssueAttachments: () => persistMock(),
}));

const claimMock = vi.fn(async () => ({ existingIssueId: null as string | null }));
vi.mock('./detector-key.js', () => ({
  claimDetectorKey: () => claimMock(),
  isValidDetectorKey: (k: string) => /^[a-z0-9/-]{1,120}$/.test(k),
}));

const resolveLabelsMock = vi.fn(async () => {
  calls.push('labels');
  return ['label-1'];
});
vi.mock('./label-service.js', () => ({
  resolveLabelIdsForWrite: () => resolveLabelsMock(),
}));

const writeRelationsMock = vi.fn(async () => {
  calls.push('relations:write');
  return [
    {
      applied: {
        edgeId: 'e1',
        kind: 'blocks',
        fromIssueId: 'a',
        toIssueId: 'b',
        created: true,
        updated: false,
      },
      input: { projectId: PROJECT_ID, fromIssueId: 'a', toIssueId: 'b', kind: 'blocks' },
      written: { id: 'e1', created: true, updated: false, effect: 'added' },
    },
  ];
});
const flushRelationsMock = vi.fn(async () => {
  calls.push('relations:flush');
});
vi.mock('./relations-service.js', () => ({
  writeIssueRelations: () => writeRelationsMock(),
  flushIssueRelationEffects: () => flushRelationsMock(),
}));

const emitMock = vi.fn(async () => {
  calls.push('issueCreated');
});
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...a: unknown[]) => emitMock(...(a as [])) },
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ROW = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: PROJECT_ID,
  issSeq: 7,
  title: 'New',
  description: null,
  status: 'open',
  priority: 'medium',
  category: null,
  reportedBy: null,
  assigneeId: null,
};

const { createIssue, IssueCreateError } = await import('./create-service.js');

const writer = {
  createdById: '33333333-3333-4333-8333-333333333333',
  createdVia: 'mcp' as const,
  actor: {
    type: 'device' as const,
    id: '44444444-4444-4444-8444-444444444444',
    agency: 'agent' as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  insertReturning.mockResolvedValue([{ ...ROW }]);
  claimMock.mockResolvedValue({ existingIssueId: null });
});

describe('createIssue — the ordering the dispatcher depends on', () => {
  it('commits relations BEFORE issueCreated, which is what wakes the dispatcher', async () => {
    await createIssue(
      { projectId: PROJECT_ID, title: 'New', relations: [{ kind: 'blocks', dependsOnId: 'x' }] },
      writer,
    );
    expect(calls.indexOf('relations:flush')).toBeLessThan(calls.indexOf('issueCreated'));
  });

  // cm:guard assert the edge write sits between BEGIN and COMMIT, not merely before `issueCreated`. Ordering alone was already true when the edge was written after the commit — and that is the arrangement ISS-889 found: the issue is durable, the blocker is not, and a crash in between leaves a row the dispatcher's POLL picks up as unblocked. Only the transaction boundary can witness that difference.
  it('writes the edge INSIDE the create transaction, not after it commits', async () => {
    await createIssue(
      { projectId: PROJECT_ID, title: 'New', relations: [{ kind: 'blocks', dependsOnId: 'x' }] },
      writer,
    );
    expect(calls.indexOf('relations:write')).toBeGreaterThan(calls.indexOf('tx:begin'));
    expect(calls.indexOf('relations:write')).toBeLessThan(calls.indexOf('tx:commit'));
  });

  it('announces the edge only AFTER the transaction commits', async () => {
    await createIssue(
      { projectId: PROJECT_ID, title: 'New', relations: [{ kind: 'blocks', dependsOnId: 'x' }] },
      writer,
    );
    expect(calls.indexOf('relations:flush')).toBeGreaterThan(calls.indexOf('tx:commit'));
  });

  it('persists attachments BEFORE issueCreated, so an agent woken by it sees them', async () => {
    await createIssue(
      {
        projectId: PROJECT_ID,
        title: 'New',
        attachments: [{ name: 'a', mime: 'text/plain', dataBase64: 'eA==' }],
      },
      writer,
    );
    expect(calls.indexOf('attachments')).toBeLessThan(calls.indexOf('issueCreated'));
  });

  it('resolves labels BEFORE the insert, so a bad label leaves no half-created issue', async () => {
    await createIssue({ projectId: PROJECT_ID, title: 'New', labels: ['bug'] }, writer);
    expect(calls.indexOf('labels')).toBeLessThan(calls.indexOf('insert'));
  });

  it('writes no issue at all when label resolution rejects', async () => {
    resolveLabelsMock.mockRejectedValueOnce(new Error('INVALID_LABELS'));
    await expect(
      createIssue({ projectId: PROJECT_ID, title: 'New', labels: ['nope'] }, writer),
    ).rejects.toThrow(/INVALID_LABELS/);
    expect(txInsert).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('createIssue — entry status allow-list (ISS-130 / ISS-236)', () => {
  it.each(['open', 'on_hold', 'draft'])('accepts %s at create', async (status) => {
    await createIssue({ projectId: PROJECT_ID, title: 'New', status }, writer);
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });

  it('refuses any other status and writes nothing', async () => {
    await expect(
      createIssue({ projectId: PROJECT_ID, title: 'New', status: 'developed' }, writer),
    ).rejects.toBeInstanceOf(IssueCreateError);
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('defaults to open when omitted', async () => {
    await createIssue({ projectId: PROJECT_ID, title: 'New' }, writer);
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
  });

  it('lets the intake gate override the requested status', async () => {
    applyIntakeGateMock.mockResolvedValueOnce({ status: 'draft', gated: true });
    await createIssue({ projectId: PROJECT_ID, title: 'New', status: 'open' }, writer);
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
    expect(finalizeIntakeMock).toHaveBeenCalledTimes(1);
  });

  it('does not notify the owner when the gate did not park the issue', async () => {
    await createIssue({ projectId: PROJECT_ID, title: 'New' }, writer);
    expect(finalizeIntakeMock).not.toHaveBeenCalled();
  });
});

describe('createIssue — one live issue per detectorKey', () => {
  it('returns the existing issue and writes nothing when the key is already claimed', async () => {
    claimMock.mockResolvedValueOnce({ existingIssueId: 'existing-id' });
    selectLimit.mockResolvedValueOnce([{ issSeq: 42, status: 'open' }]);

    const result = await createIssue(
      { projectId: PROJECT_ID, title: 'New', detectorKey: 'lint/no-any' },
      writer,
    );

    expect(result).toMatchObject({
      deduped: true,
      existingIssueId: 'existing-id',
      existingIssueDisplayId: 'ISS-42',
      existingIssueStatus: 'open',
    });
    expect(txInsert).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('creates normally when the key is unclaimed', async () => {
    const result = await createIssue(
      { projectId: PROJECT_ID, title: 'New', detectorKey: 'lint/no-any' },
      writer,
    );
    expect(result.deduped).toBe(false);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ detectorKey: 'lint/no-any' }),
    );
  });

  it('refuses a malformed key before claiming or inserting anything', async () => {
    await expect(
      createIssue({ projectId: PROJECT_ID, title: 'New', detectorKey: 'NOT A KEY' }, writer),
    ).rejects.toBeInstanceOf(IssueCreateError);
    expect(claimMock).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });
});

describe("createIssue — the writer identity is the caller's, never a default", () => {
  it('records createdVia and createdById exactly as handed in', async () => {
    await createIssue({ projectId: PROJECT_ID, title: 'New' }, { ...writer, createdVia: 'web' });
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ createdVia: 'web', createdById: writer.createdById }),
    );
  });

  it('emits issueCreated under the same actor', async () => {
    await createIssue({ projectId: PROJECT_ID, title: 'New' }, writer);
    expect(emitMock).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ actor: writer.actor }),
    );
  });
});
