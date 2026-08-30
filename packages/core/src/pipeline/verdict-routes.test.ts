import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn(async () => [] as unknown[]);
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

vi.mock('../db/schema.js', () => ({ jobs: {} }));

const verifyDeviceToken = vi.fn(async (_token: string) => ({ id: 'dev-1' }));
vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: (token: string) => verifyDeviceToken(token),
}));

const recordVerdictMock = vi.fn(async (_input: unknown) => undefined);
const nextAttemptMock = vi.fn(async (_runId: string, _phase: string) => 4);
vi.mock('./phase-journal.js', () => ({
  recordVerdict: (input: unknown) => recordVerdictMock(input),
  nextAttempt: (runId: string, phase: string) => nextAttemptMock(runId, phase),
  startPhase: vi.fn(),
}));

const resolveWedgeMock = vi.fn(async (_entityId: string) => 0);
vi.mock('./wedge.js', () => ({
  resolvePipelineWedge: (entityId: string) => resolveWedgeMock(entityId),
  reviewRoundsWedgeEntityId: (runId: string) => `rounds:${runId}`,
}));

const { verdictRoutes } = await import('./verdict-routes.js');

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const app = new Hono().route('/api/jobs', verdictRoutes);

function post(decision: string) {
  return app.request(`/api/jobs/${JOB_ID}/verdict`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify({ phase: 'review', attempt: 5, decision }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([
    {
      projectId: 'proj-1',
      issueId: 'iss-1',
      pipelineRunId: RUN_ID,
      deviceId: 'dev-1',
      agentSessionId: null,
    },
  ]);
  verifyDeviceToken.mockResolvedValue({ id: 'dev-1' });
});

describe('POST /api/jobs/:id/verdict', () => {
  // cm:guard an approve is the ONLY observer of a rejection streak ending — `alarmRejectionStreaks` re-emits on a 24h floor keyed on `resolvedAt IS NULL`, so without this the bell stays red about a review loop that has since landed
  it('resolves the run rejection-streak wedge on approve', async () => {
    const res = await post('approve');

    expect(res.status).toBe(200);
    expect(resolveWedgeMock).toHaveBeenCalledWith(`rounds:${RUN_ID}`);
  });

  // cm:guard a rejection must NOT resolve it — request_changes is the event that grows the streak, and clearing the wedge here would make the alarm unable to survive its own subject continuing
  it('leaves the wedge unresolved on request_changes', async () => {
    const res = await post('request_changes');

    expect(res.status).toBe(200);
    expect(resolveWedgeMock).not.toHaveBeenCalled();
  });

  it('records the verdict before resolving anything', async () => {
    await post('approve');

    expect(recordVerdictMock).toHaveBeenCalledTimes(1);
    const call = recordVerdictMock.mock.calls[0]?.[0] as { runId: string; outcome: string };
    expect(call.runId).toBe(RUN_ID);
    expect(call.outcome).toBe('ok');
  });

  it('does not resolve a wedge when the job is not this device', async () => {
    selectLimit.mockResolvedValue([
      {
        projectId: 'proj-1',
        issueId: 'iss-1',
        pipelineRunId: RUN_ID,
        deviceId: 'other-device',
        agentSessionId: null,
      },
    ]);

    const res = await post('approve');

    expect(res.status).toBe(403);
    expect(resolveWedgeMock).not.toHaveBeenCalled();
  });
});
