import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each resolveActors() query ends in `.where(...)` which is awaited directly, so
// a single `whereMock` queue (mockResolvedValueOnce) drives every batched read
// in call order: users → devices → device-owner users (each guarded, so a
// branch that doesn't run consumes no queue entry).
const whereMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
}));

const { resolveActors, actorKey } = await import('./actor-resolution.js');

const U1 = '11111111-1111-4111-8111-111111111111';
const O1 = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  whereMock.mockReset();
});

describe('resolveActors', () => {
  it('returns an empty map and makes no query for empty input', async () => {
    const result = await resolveActors([]);
    expect(result.size).toBe(0);
    expect(whereMock).not.toHaveBeenCalled();
  });

  it('resolves a user actor to its email (not an agent)', async () => {
    whereMock.mockResolvedValueOnce([{ id: U1, email: 'alice@example.com' }]);
    const result = await resolveActors([{ type: 'user', id: U1 }]);
    const actor = result.get(actorKey('user', U1));
    expect(actor).toEqual({
      type: 'user',
      id: U1,
      displayName: 'alice@example.com',
      isAgent: false,
    });
  });

  it('resolves a device actor to its name + owner email and flags it as an agent', async () => {
    // userIds empty → users query skipped; devices query first, owner query second.
    whereMock
      .mockResolvedValueOnce([{ id: D1, name: 'CI Runner', ownerId: O1 }])
      .mockResolvedValueOnce([{ id: O1, email: 'owner@example.com' }]);
    const result = await resolveActors([{ type: 'device', id: D1 }]);
    const actor = result.get(actorKey('device', D1));
    expect(actor).toEqual({
      type: 'device',
      id: D1,
      displayName: 'CI Runner',
      isAgent: true,
      deviceId: D1,
      ownerEmail: 'owner@example.com',
    });
  });

  it('degrades an unknown user to the Unknown fallback without throwing', async () => {
    whereMock.mockResolvedValueOnce([]); // no matching user row
    const result = await resolveActors([{ type: 'user', id: U1 }]);
    expect(result.get(actorKey('user', U1))).toEqual({
      type: 'user',
      id: U1,
      displayName: 'Unknown',
      isAgent: false,
    });
  });

  it('degrades an unknown device to the Unknown agent fallback', async () => {
    whereMock.mockResolvedValueOnce([]); // no matching device row
    const result = await resolveActors([{ type: 'device', id: D1 }]);
    expect(result.get(actorKey('device', D1))).toEqual({
      type: 'device',
      id: D1,
      displayName: 'Unknown',
      isAgent: true,
      deviceId: D1,
    });
  });

  it('dedupes repeated refs into one resolved entry', async () => {
    whereMock.mockResolvedValueOnce([{ id: U1, email: 'alice@example.com' }]);
    const result = await resolveActors([
      { type: 'user', id: U1 },
      { type: 'user', id: U1 },
    ]);
    expect(result.size).toBe(1);
    expect(result.get(actorKey('user', U1))?.displayName).toBe('alice@example.com');
  });
});
