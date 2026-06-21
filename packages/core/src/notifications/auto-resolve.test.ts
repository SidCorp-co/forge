import { beforeEach, describe, expect, it, vi } from 'vitest';

// db.update(...).set(...).where(...).returning() → cleared rows.
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock('../db/client.js', () => ({
  db: { update: vi.fn(() => ({ set: updateSet })) },
}));

const { resolveNotifications } = await import('./auto-resolve.js');
const hooksModule = await import('../pipeline/hooks.js');

beforeEach(() => {
  vi.clearAllMocks();
  updateReturning.mockReset();
  hooksModule.hooks.reset();
});

describe('resolveNotifications', () => {
  it('marks matching unread rows read and emits notificationRead per row', async () => {
    updateReturning.mockResolvedValueOnce([
      { id: 'n1', userId: 'u1' },
      { id: 'n2', userId: 'u2' },
    ]);
    const seen: Array<{ id: string; user: string }> = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push({ id: p.notificationId, user: p.userId });
    });

    const count = await resolveNotifications('issue:abc:status');

    expect(count).toBe(2);
    // read=true is set; resolvedAt is stamped (a Date).
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ read: true, resolvedAt: expect.any(Date) }),
    );
    expect(seen).toEqual([
      { id: 'n1', user: 'u1' },
      { id: 'n2', user: 'u2' },
    ]);
  });

  it('is idempotent — no unread rows clears nothing and emits nothing', async () => {
    updateReturning.mockResolvedValueOnce([]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push(p.notificationId);
    });

    const count = await resolveNotifications('issue:abc:status');

    expect(count).toBe(0);
    expect(seen).toEqual([]);
  });

  it('returns 0 for an empty key without touching the db', async () => {
    const count = await resolveNotifications('');
    expect(count).toBe(0);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('never throws when the db update fails (best-effort)', async () => {
    updateReturning.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveNotifications('issue:abc:status')).resolves.toBe(0);
  });
});
