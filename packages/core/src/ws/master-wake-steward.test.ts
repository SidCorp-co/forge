// REQ-48: the steward's ask of the master rides the master wake under its own source, and the runner
// reads every source core sends by name (`runner-daemon/src/wake_source.rs:WakeSource`), so a source
// added here without its reader goes red here rather than as a refused wake on a box.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { MASTER_WAKE_SOURCES, wakeMastersForSteward } = await import('./master-wake.js');

const RUNNER_WAKE_SOURCE = new URL(
  '../../../runner/crates/runner-daemon/src/wake_source.rs',
  import.meta.url,
);

describe('the steward wake (REQ-48)', () => {
  beforeEach(() => {
    published.length = 0;
  });

  it("wakes every box under the source 'steward', naming the item and the ask", async () => {
    const out = await wakeMastersForSteward({
      projectId: 'p1',
      subjectKey: 'ISS-7',
      ask: 'ISS-7 waits for a master since 10-14',
    });
    expect(out).toEqual({ boxes: 1, delivered: 1 });
    expect(published).toEqual([
      {
        room: 'device:box-1',
        frame: {
          event: 'master.wake',
          data: {
            projectId: 'p1',
            source: 'steward',
            subjectKey: 'ISS-7',
            ask: 'ISS-7 waits for a master since 10-14',
          },
        },
      },
    ]);
  });

  it('sends no source the runner does not read by name', () => {
    const rust = readFileSync(RUNNER_WAKE_SOURCE, 'utf8');
    const unread = MASTER_WAKE_SOURCES.filter((s) => !rust.includes(`"${s}" => Ok(WakeSource::`));
    expect(unread).toEqual([]);
  });
});
