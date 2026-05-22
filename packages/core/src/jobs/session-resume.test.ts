import { describe, expect, it, vi, beforeEach } from 'vitest';

const limitResults: unknown[][] = [];
const limit = vi.fn(() => Promise.resolve(limitResults.shift() ?? []));
const orderBy = vi.fn(() => ({ limit }));
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from })) },
}));

const { findPriorSessionInGroup } = await import('./session-resume.js');

beforeEach(() => {
  limitResults.length = 0;
  limit.mockClear();
});

describe('findPriorSessionInGroup', () => {
  it('returns null when no prior completed session has the (issue, group) pair', async () => {
    limitResults.push([]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns the most recent claudeSessionId + deviceId when one exists', async () => {
    limitResults.push([
      { claudeSessionId: 'cli-abc123', deviceId: 'd-1' },
    ]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toEqual({ claudeSessionId: 'cli-abc123', deviceId: 'd-1' });
  });

  it('swallows DB errors and returns null', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });

  it('returns null when row exists but claudeSessionId is missing', async () => {
    limitResults.push([{ claudeSessionId: null, deviceId: 'd-1' }]);
    const r = await findPriorSessionInGroup({ issueId: 'i-1', sessionGroup: 'impl' });
    expect(r).toBeNull();
  });
});
