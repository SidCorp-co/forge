import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);
vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const issueSelectLimit = vi.fn(async () => [] as Array<{ manualHold: boolean; projectId: string; ownerId: string }>);
const issueSelectWhere = vi.fn(() => ({ limit: issueSelectLimit }));
const issueSelectJoin = vi.fn(() => ({ where: issueSelectWhere }));
const issueSelectFrom = vi.fn(() => ({ innerJoin: issueSelectJoin }));
const dbSelect = vi.fn(() => ({ from: issueSelectFrom }));

const issueUpdateWhere = vi.fn(async () => undefined);
const issueUpdateSet = vi.fn(() => ({ where: issueUpdateWhere }));
const dbUpdate = vi.fn(() => ({ set: issueUpdateSet }));

const commentInsertValues = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({ values: commentInsertValues }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect, update: dbUpdate, insert: dbInsert },
}));

const wsPublish = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => wsPublish(...args) },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setManualHoldBlock } = await import('./manual-hold.js');

beforeEach(() => {
  vi.clearAllMocks();
  issueSelectLimit.mockResolvedValue([]);
  commentInsertValues.mockResolvedValue(undefined);
});

const SAMPLE_CONTEXT = {
  step: 'code' as const,
  trigger: 'watchdog_kill' as const,
  classification: {
    kind: 'unknown' as const,
    reason: 'no session heartbeat',
    evidence: { jobId: 'j1', sessionId: null },
  },
  attempts: 2,
  lastFailureAt: '2026-05-16T02:00:00Z',
  suggestedActions: ['resume', 'skip-step', 'close'] as const,
};

describe('setManualHoldBlock', () => {
  it('writes manual_hold + failure_context onto the issue', async () => {
    issueSelectLimit.mockResolvedValueOnce([
      { manualHold: false, projectId: 'p1', ownerId: 'u1' },
    ]);
    await setManualHoldBlock({
      issueId: 'i1',
      context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
    });

    expect(issueUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = issueUpdateSet.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(setArg?.manualHold).toBe(true);
    expect(setArg?.failureContext).toMatchObject({
      step: 'code',
      trigger: 'watchdog_kill',
      classification: { kind: 'unknown' },
    });
  });

  it('posts a block comment when the issue was not already blocked', async () => {
    issueSelectLimit.mockResolvedValueOnce([
      { manualHold: false, projectId: 'p1', ownerId: 'u1' },
    ]);
    await setManualHoldBlock({
      issueId: 'i1',
      context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
    });

    expect(commentInsertValues).toHaveBeenCalledTimes(1);
    const commentArg = commentInsertValues.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(commentArg?.issueId).toBe('i1');
    expect(commentArg?.authorId).toBe('u1');
    expect(String(commentArg?.body)).toContain('Pipeline blocked at step');
    expect(String(commentArg?.body)).toContain('code');
    expect(String(commentArg?.body)).toContain('Resume');
  });

  it('does not post a duplicate comment when already blocked', async () => {
    issueSelectLimit.mockResolvedValueOnce([
      { manualHold: true, projectId: 'p1', ownerId: 'u1' },
    ]);
    await setManualHoldBlock({
      issueId: 'i1',
      context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
    });

    expect(commentInsertValues).not.toHaveBeenCalled();
    expect(issueUpdateSet).toHaveBeenCalled();
  });

  it('broadcasts pipeline.decision_required to the project room', async () => {
    issueSelectLimit.mockResolvedValueOnce([
      { manualHold: false, projectId: 'p1', ownerId: 'u1' },
    ]);
    await setManualHoldBlock({
      issueId: 'i1',
      context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
    });

    expect(wsPublish).toHaveBeenCalledTimes(1);
    const [room, envelope] = wsPublish.mock.calls[0] as [
      string,
      { event: string; data: Record<string, unknown> },
    ];
    expect(room).toBe('project:p1');
    expect(envelope.event).toBe('pipeline.decision_required');
    expect(envelope.data).toMatchObject({
      issueId: 'i1',
      step: 'code',
      trigger: 'watchdog_kill',
      attempts: 2,
    });
  });

  it('continues when comment insert throws', async () => {
    issueSelectLimit.mockResolvedValueOnce([
      { manualHold: false, projectId: 'p1', ownerId: 'u1' },
    ]);
    commentInsertValues.mockRejectedValueOnce(new Error('db down'));
    await expect(
      setManualHoldBlock({
        issueId: 'i1',
        context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
      }),
    ).resolves.toBeUndefined();
    expect(wsPublish).toHaveBeenCalled();
  });

  it('no-ops when the issue does not exist', async () => {
    issueSelectLimit.mockResolvedValueOnce([]);
    await setManualHoldBlock({
      issueId: 'i-missing',
      context: { ...SAMPLE_CONTEXT, suggestedActions: [...SAMPLE_CONTEXT.suggestedActions] },
    });

    expect(issueUpdateSet).not.toHaveBeenCalled();
    expect(commentInsertValues).not.toHaveBeenCalled();
    expect(wsPublish).not.toHaveBeenCalled();
  });
});
