import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

// cm:why mirrors runs.test.ts's db.transaction mock — invokes the callback with a tx handle whose select/update chain is structurally identical to db for the calls rejectReconcileRun issues (select().where().for('update').limit(), update().set().where()).
const state = vi.hoisted(() => ({
  runRow: null as Record<string, unknown> | null,
  updateSetCalls: [] as Record<string, unknown>[],
}));

vi.mock('../db/client.js', () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve(state.runRow ? [state.runRow] : []),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        state.updateSetCalls.push(s);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
  return { db: { transaction: async (cb: (tx: unknown) => unknown) => cb(tx) } };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../pipeline/runs.js', () => ({ openOneShotRun: vi.fn(), closeRun: vi.fn() }));
vi.mock('../jobs/enqueue.js', () => ({ enqueueReconcileJob: vi.fn() }));
const activityMock = vi.hoisted(() => ({ recordSkillActivityEvent: vi.fn() }));
vi.mock('./activity.js', () => ({
  recordSkillActivityEvent: activityMock.recordSkillActivityEvent,
}));
vi.mock('./policy-landed.js', () => ({
  ensurePolicyLandedFor: vi.fn().mockResolvedValue(false),
}));
vi.mock('../notifications/emit.js', () => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 'n-1' }),
}));
vi.mock('../notifications/auto-resolve.js', () => ({
  resolveNotifications: vi.fn().mockResolvedValue(0),
}));

import { rejectReconcileRun } from './reconcile-service.js';

function run(status: string) {
  return {
    id: RUN_ID,
    projectId: 'proj-1',
    skillId: 'skill-1',
    packetId: 'pkt-1',
    status,
  };
}

beforeEach(() => {
  state.runRow = null;
  state.updateSetCalls = [];
  activityMock.recordSkillActivityEvent.mockClear();
});

describe('rejectReconcileRun', () => {
  it.each(['pending', 'running', 'verifying', 'decided'])(
    'escalates a %s run and logs reconcile.escalated',
    async (status) => {
      state.runRow = run(status);
      await rejectReconcileRun(RUN_ID, USER_ID, 'human rejected');

      expect(state.updateSetCalls[0]).toMatchObject({ status: 'escalated' });
      expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledOnce();
      expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'reconcile.escalated', projectId: 'proj-1' }),
      );
    },
  );

  it.each(['applied', 'escalated', 'failed'])(
    'refuses a %s (terminal) run with BAD_REQUEST, no write',
    async (status) => {
      state.runRow = run(status);
      await expect(rejectReconcileRun(RUN_ID, USER_ID, 'human rejected')).rejects.toThrow(
        /BAD_REQUEST: run is in terminal status/,
      );
      expect(state.updateSetCalls).toHaveLength(0);
      expect(activityMock.recordSkillActivityEvent).not.toHaveBeenCalled();
    },
  );

  it('throws NOT_FOUND when the run does not exist', async () => {
    state.runRow = null;
    await expect(rejectReconcileRun(RUN_ID, USER_ID, 'human rejected')).rejects.toThrow(
      /NOT_FOUND: reconcile run/,
    );
  });
});
