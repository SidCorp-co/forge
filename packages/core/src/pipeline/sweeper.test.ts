import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Side-effect mocks. processStuckIssues drives db.update + db.insert + WS
// publish + orchestrator.reEnqueueForIssue — we mock those at the module
// boundary and assert behaviour on each row.

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const insertValues = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: { update: dbUpdate, insert: dbInsert, select: vi.fn() },
}));

const reEnqueueForIssue = vi.fn(async () => undefined);
vi.mock('./orchestrator.js', () => ({
  reEnqueueForIssue: (a: unknown) => reEnqueueForIssue(a),
}));

vi.mock('./skill-mapping.js', () => ({
  resolveJobTypeForStatus: () => null,
}));

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => 'wid'),
    schedule: vi.fn(async () => undefined),
  },
}));

const { processStuckIssues, type: _t } = await import('./sweeper.js');
type StuckIssueRow = import('./sweeper.js').StuckIssueRow;

const NOW = new Date('2026-04-27T12:00:00Z');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

const baseRow = (overrides: Partial<StuckIssueRow> = {}): StuckIssueRow => ({
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  status: 'confirmed',
  recoveryAttempts: 0,
  lastRecoveryAt: null,
  recoveryWindowStartedAt: null,
  agentConfig: null,
  ownerId: OWNER_ID,
  latestJobId: JOB_ID,
  latestJobStatus: 'failed',
  latestJobFailureKind: 'transient',
  latestJobFailureReason: 'ETIMEDOUT',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('processStuckIssues', () => {
  it('returns zeros for an empty input', async () => {
    const result = await processStuckIssues([], NOW);
    expect(result).toEqual({
      scanned: 0,
      recovered: 0,
      escalated: 0,
      skipped: 0,
      durationMs: expect.any(Number),
    });
  });

  it('recovers a transient failure and bumps recovery_attempts', async () => {
    const result = await processStuckIssues([baseRow()], NOW);
    expect(result).toMatchObject({ scanned: 1, recovered: 1, escalated: 0, skipped: 0 });
    expect(reEnqueueForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: ISSUE_ID,
        actor: { type: 'user', id: OWNER_ID },
        reason: expect.objectContaining({
          sweeper: expect.objectContaining({ kind: 'recover', attempt: 1 }),
        }),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAttempts: 1, lastRecoveryAt: NOW }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      `project:${PROJECT_ID}`,
      expect.objectContaining({ event: 'pipeline.recovered' }),
    );
  });

  it('escalates a permanent failure (content filter) immediately', async () => {
    const result = await processStuckIssues(
      [
        baseRow({
          latestJobFailureKind: 'permanent',
          latestJobFailureReason: 'invalid_request_error: Output blocked by content filtering',
        }),
      ],
      NOW,
    );
    expect(result).toMatchObject({ recovered: 0, escalated: 1 });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pipeline_failed' }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: ISSUE_ID,
        body: expect.stringContaining('Pipeline gave up'),
        isAi: true,
      }),
    );
    expect(publishSpy).toHaveBeenCalledWith(
      `project:${PROJECT_ID}`,
      expect.objectContaining({
        event: 'pipeline.escalated',
        data: expect.objectContaining({ to: 'pipeline_failed' }),
      }),
    );
    expect(reEnqueueForIssue).not.toHaveBeenCalled();
  });

  it('skips when latest job has no failureKind (cancelled / done)', async () => {
    const result = await processStuckIssues(
      [
        baseRow({
          latestJobStatus: 'cancelled',
          latestJobFailureKind: null,
          latestJobFailureReason: null,
        }),
      ],
      NOW,
    );
    expect(result.skipped).toBe(1);
    expect(reEnqueueForIssue).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('escalates when transient cap (default 5) is exhausted', async () => {
    const result = await processStuckIssues(
      [
        baseRow({
          recoveryAttempts: 5,
          lastRecoveryAt: new Date('2026-04-27T11:30:00Z'),
          recoveryWindowStartedAt: new Date('2026-04-27T11:00:00Z'),
        }),
      ],
      NOW,
    );
    expect(result).toMatchObject({ recovered: 0, escalated: 1 });
  });

  it('resets the recovery window when 24h+ have elapsed', async () => {
    await processStuckIssues(
      [
        baseRow({
          recoveryAttempts: 99,
          lastRecoveryAt: new Date('2026-04-25T12:00:00Z'),
          recoveryWindowStartedAt: new Date('2026-04-25T12:00:00Z'),
        }),
      ],
      NOW,
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryAttempts: 1,
        recoveryWindowStartedAt: NOW,
      }),
    );
  });

  it('continues processing when one row throws', async () => {
    reEnqueueForIssue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const result = await processStuckIssues(
      [
        baseRow({ id: 'i1' }),
        baseRow({ id: 'i2' }),
        baseRow({ id: 'i3' }),
      ],
      NOW,
    );
    expect(result.scanned).toBe(3);
    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('respects per-project pipelineConfig override (tighter unknown cap)', async () => {
    const result = await processStuckIssues(
      [
        baseRow({
          recoveryAttempts: 1,
          lastRecoveryAt: new Date('2026-04-27T11:30:00Z'),
          recoveryWindowStartedAt: new Date('2026-04-27T11:30:00Z'),
          latestJobFailureKind: 'unknown',
          agentConfig: {
            pipelineConfig: {
              recoveryByFailureKind: { unknown: 1 },
            },
          },
        }),
      ],
      NOW,
    );
    expect(result.escalated).toBe(1);
    expect(result.recovered).toBe(0);
  });
});
