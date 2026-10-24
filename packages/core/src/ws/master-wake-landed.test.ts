import { OUTBOX_CONSUMERS } from '@forge/contracts/outbox-consumers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-564 round 2: landed work the wedge pass leaves moves no status, so no `issue.transitioned`
// wakes anyone; its own event wakes the master that owes the move to awaiting_release.

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

describe('the master wake for landed work the wedge pass left', () => {
  beforeAll(() => registerMasterWakeSubscribers());
  beforeEach(() => {
    published.length = 0;
  });

  it('is declared on the outbox for the master wake', () => {
    expect(OUTBOX_CONSUMERS['issue.landedWorkLeft']).toEqual(['master-wake']);
  });

  it('wakes every box of the project, naming the issue at in_progress', async () => {
    await consumerOf('issue.landedWorkLeft', 'master-wake')?.handle(
      {
        issueId: 'i1',
        projectId: 'p1',
        mergedAt: '2026-10-24T20:00:00.000Z',
        commit: `${'a'.repeat(39)}1`,
        landing: null,
      },
      {} as never,
    );
    expect(published).toEqual([
      {
        room: 'device:box-1',
        frame: {
          event: 'master.wake',
          data: {
            projectId: 'p1',
            source: 'issue',
            issueId: 'i1',
            status: 'in_progress',
            charter: expect.any(String),
          },
        },
      },
    ]);
  });
});
