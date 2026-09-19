import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const queue: unknown[] = [];

// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.leftJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
chain.values = () => chain;
chain.returning = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
  },
}));

// The escalation's notification: mocked at `emit.ts` so these cases stay about what
// `writePmDecision` does with the answer, rather than about the delivery layer's own
// queries. `null` is what the emission switch returns for a suppressed type.
const emitNotificationSpy = vi.fn<(input: unknown) => Promise<{ id: string } | null>>();
vi.mock('../../notifications/emit.js', () => ({
  emitNotification: (input: unknown) => emitNotificationSpy(input),
}));

const indexMemorySpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../memory/indexer.js', () => ({
  indexMemory: indexMemorySpy,
}));

const hooksEmitSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: hooksEmitSpy },
}));

const { pmWriteDecisionHandler, pmWriteDecisionInputSchema } = await import(
  './forge-pm-write-decision.js'
);
const { writePmDecision } = await import('../../pm/decisions-service.js');

const forgePmWriteDecisionTool = () => ({
  handler: async (args: unknown) => writePmDecision(pmWriteDecisionInputSchema.parse(args)),
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
  emitNotificationSpy.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' });
});

describe('forge_pm.write_decision', () => {
  it('rejects unknown cause', async () => {
    const tool = forgePmWriteDecisionTool();
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'mystery',
        summary: 'x',
      }),
    ).rejects.toThrow();
  });

  it('inserts decision + queues memory indexer', async () => {
    const tool = forgePmWriteDecisionTool();
    const decisionInsert = [{ id: DECISION_ID }];
    queue.push(decisionInsert);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      cause: 'job-failed',
      summary: 'Recovered failed code job by re-running',
      actions: [{ kind: 'dispatch', jobId: 'j1' }],
    })) as { decisionId: string; indexed: 'queued' };

    expect(result.decisionId).toBe(DECISION_ID);
    expect(result.indexed).toBe('queued');

    await new Promise<void>((r) => queueMicrotask(() => r()));

    expect(indexMemorySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        source: 'decision',
        sourceRef: DECISION_ID,
      }),
    );
  });

  it('with escalate: records the escalation against the project owner', async () => {
    const tool = forgePmWriteDecisionTool();
    queue.push([{ id: DECISION_ID }], [{ createdBy: OWNER_ID }]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      cause: 'needs-info',
      summary: 'Need owner sign-off',
      actions: [],
      escalate: {
        severity: 'high',
        summary: 'Approve plan?',
        question: 'Pick one',
        options: [
          { id: 'a', label: 'Approve' },
          { id: 'b', label: 'Reject' },
        ],
        expiresAt: '2026-06-01T00:00:00.000Z',
      },
    })) as { escalation: { notificationId: string } };

    expect(emitNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pm_escalation', userId: OWNER_ID, decisionId: DECISION_ID }),
    );
    expect(result.escalation.notificationId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('with escalate refused by the switch: writes the decision, then refuses naming it', async () => {
    const tool = forgePmWriteDecisionTool();
    emitNotificationSpy.mockResolvedValue(null);
    queue.push([{ id: DECISION_ID }], [{ createdBy: OWNER_ID }]);

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'needs-info',
        summary: 'Need owner sign-off',
        actions: [],
        escalate: {
          severity: 'high',
          summary: 'Approve plan?',
          question: 'Pick one',
          options: [
            { id: 'a', label: 'Approve' },
            { id: 'b', label: 'Reject' },
          ],
          expiresAt: '2026-06-01T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/ISS-1063 emission switch/);

    expect(hooksEmitSpy).not.toHaveBeenCalledWith(
      'notificationCreated',
      expect.objectContaining({ type: 'pm_escalation' }),
    );
  });

  it('with escalate but missing project: throws NOT_FOUND', async () => {
    const tool = forgePmWriteDecisionTool();
    const decisionInsert = [{ id: DECISION_ID }];
    const projectLookupEmpty: unknown[] = [];
    queue.push(decisionInsert, projectLookupEmpty);

    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'needs-info',
        summary: 'x',
        actions: [],
        escalate: {
          severity: 'low',
          summary: 's',
          question: 'q',
          options: [{ id: 'a', label: 'Approve' }],
          expiresAt: '2026-06-01T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('rejects escalate with empty options', async () => {
    const tool = forgePmWriteDecisionTool();
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        cause: 'needs-info',
        summary: 'x',
        actions: [],
        escalate: {
          severity: 'low',
          summary: 's',
          question: 'q',
          options: [],
          expiresAt: '2026-06-01T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow();
  });
  it('the MCP action itself refuses every caller /mcp can produce', async () => {
    await expect(
      pmWriteDecisionHandler(
        fakePrincipal,
        pmWriteDecisionInputSchema.parse({
          projectId: PROJECT_ID,
          cause: 'job-failed',
          summary: 'a decision nobody can write over MCP',
          eventRef: {},
          actions: [],
        }),
      ),
    ).rejects.toThrow(/PM_REQUIRES_DEVICE/);
  });
});
