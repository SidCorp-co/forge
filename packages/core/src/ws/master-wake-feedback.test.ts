import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const published = vi.hoisted(() => [] as { room: string; frame: unknown }[]);

vi.mock('../db/client.js', () => ({
  db: {
    selectDistinct: () => ({ from: () => ({ where: async () => [{ deviceId: 'box-1' }] }) }),
  },
}));
vi.mock('../lib/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  roomManager: {
    publish: (room: string, frame: unknown) => {
      published.push({ room, frame });
      return 1;
    },
  },
}));

const { consumerOf } = await import('../outbox/consumers.js');
const { registerMasterWakeSubscribers } = await import('./master-wake.js');

describe('feedback-lifecycle start: the master wake for filed feedback', () => {
  beforeAll(() => registerMasterWakeSubscribers());
  beforeEach(() => {
    published.length = 0;
  });

  it('is declared on the outbox for the master wake', () => {
    expect(OUTBOX_CONSUMERS['feedback.filed']).toContain('master-wake');
  });

  it.each(['high', 'critical'] as const)(
    'wakes every box for %s feedback, naming it',
    async (severity) => {
      await consumerOf('feedback.filed', 'master-wake')?.handle(
        { projectId: 'p1', feedbackId: 'f1', severity },
        {} as never,
      );
      expect(published).toEqual([
        {
          room: 'device:box-1',
          frame: {
            event: 'master.wake',
            data: { projectId: 'p1', source: 'feedback', feedbackId: 'f1', severity },
          },
        },
      ]);
    },
  );

  it.each(['low', 'medium'] as const)('wakes nobody for %s feedback', async (severity) => {
    await consumerOf('feedback.filed', 'master-wake')?.handle(
      { projectId: 'p1', feedbackId: 'f1', severity },
      {} as never,
    );
    expect(published).toEqual([]);
  });
});
