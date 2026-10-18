import { describe, expect, it, vi } from 'vitest';

const { execute, publishBoxState } = vi.hoisted(() => ({
  execute: vi.fn(),
  publishBoxState: vi.fn(async () => {}),
}));
vi.mock('../db/client.js', () => ({ db: { execute } }));
vi.mock('../queue/boss.js', () => ({ boss: {} }));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('./box-state-publish.js', () => ({ publishBoxState }));

import { runDeviceStaleSweep } from './stale-detector.js';

describe('runDeviceStaleSweep', () => {
  it('tells every project of each box it marks offline, not only the box', async () => {
    execute.mockResolvedValueOnce([
      { id: 'd1', owner_id: 'u1' },
      { id: 'd2', owner_id: 'u1' },
    ]);
    const out = await runDeviceStaleSweep();
    expect(out.markedOffline).toBe(2);
    expect(publishBoxState.mock.calls).toEqual([
      ['d1', 'offline', 'stale'],
      ['d2', 'offline', 'stale'],
    ]);
  });
});
