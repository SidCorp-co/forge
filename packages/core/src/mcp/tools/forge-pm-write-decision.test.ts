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

// cm:why these cases have moved down a layer TWICE, each time to the layer that still runs. First off the deprecated `forge_pm.<action>` shim, when that was deleted; now off `pmWriteDecisionHandler`, because ISS-931 put an unconditional credential refusal in front of it — the action needs a `runners` row keyed on a paired device and `/mcp` no longer authenticates one. `writePmDecision` is live code with no other caller and no REST twin, so its behaviour is asserted here directly; the refusal itself is the last case in this file.
const forgePmWriteDecisionTool = () => ({
  handler: async (args: unknown) => writePmDecision(pmWriteDecisionInputSchema.parse(args)),
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const NOTIFICATION_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
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

    // cm:guard the indexer is scheduled on a microtask, NOT awaited by the handler — drop this flush and the assertion below runs before the call it is looking for, passing or failing on timing rather than behaviour
    await new Promise<void>((r) => queueMicrotask(() => r()));

    expect(indexMemorySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        source: 'decision',
        sourceRef: DECISION_ID,
      }),
    );
  });

  it('with escalate: inserts notification + emits hook + returns escalation', async () => {
    const tool = forgePmWriteDecisionTool();
    const decisionInsert = [{ id: DECISION_ID }];
    const escalationProjectLookup = [{ createdBy: OWNER_ID }];
    const notificationInsert = [{ id: NOTIFICATION_ID }];
    queue.push(decisionInsert, escalationProjectLookup, notificationInsert);

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
    })) as {
      decisionId: string;
      indexed: 'queued';
      escalation: { notificationId: string; expiresAt: string };
    };

    expect(result.decisionId).toBe(DECISION_ID);
    expect(result.escalation.notificationId).toBe(NOTIFICATION_ID);
    expect(result.escalation.expiresAt).toBe('2026-06-01T00:00:00.000Z');
    expect(hooksEmitSpy).toHaveBeenCalledWith(
      'notificationCreated',
      expect.objectContaining({
        notificationId: NOTIFICATION_ID,
        type: 'pm_escalation',
        userId: OWNER_ID,
        decisionId: DECISION_ID,
      }),
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
  // cm:guard the MCP action is refused on the CREDENTIAL, and this is the case that says so. Without it, `writePmDecision` above looks reachable from an agent and the three cases before it read as coverage of a live MCP action rather than of a service behind a permanent refusal (ISS-931).
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
