import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, publish } = vi.hoisted(() => ({ execute: vi.fn(), publish: vi.fn() }));
vi.mock('../db/client.js', () => ({ db: { execute } }));
vi.mock('../ws/server.js', () => ({ roomManager: { publish } }));

import { projectRoom } from '../ws/rooms.js';
import { publishBoxState } from './box-state-publish.js';

beforeEach(() => {
  execute.mockReset();
  publish.mockReset();
});

// ISS-1228 round 15 repair: a box's flip reached its device room only, which no page joins, so the box
// strip and the session rows each learned it on their own poll and disagreed until both polled.
describe('publishBoxState', () => {
  it('tells every project the box serves, naming the project, as well as the box itself', async () => {
    execute.mockResolvedValueOnce([{ project_id: 'p1' }, { project_id: 'p2' }]);
    await publishBoxState('d1', 'offline', 'stale');

    const told = publish.mock.calls.map(([room, msg]) => ({ room, msg }));
    expect(told).toContainEqual({
      room: projectRoom('p1'),
      msg: { event: 'device.status', data: { deviceId: 'd1', projectId: 'p1', status: 'offline' } },
    });
    expect(told).toContainEqual({
      room: projectRoom('p2'),
      msg: { event: 'device.status', data: { deviceId: 'd1', projectId: 'p2', status: 'offline' } },
    });
    expect(told).toHaveLength(3);
  });

  it('tells only the box where it serves no project', async () => {
    execute.mockResolvedValueOnce([]);
    await publishBoxState('d1', 'online');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toEqual({
      event: 'device.status',
      data: { deviceId: 'd1', status: 'online' },
    });
  });
});
