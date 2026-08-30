import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn();

vi.mock('../db/client.js', () => ({ db: { execute: (...a: unknown[]) => dbExecute(...a) } }));

const { resolveNotifications } = await import('./auto-resolve.js');
const hooksModule = await import('../pipeline/hooks.js');

beforeEach(() => {
  vi.clearAllMocks();
  dbExecute.mockReset();
  dbExecute.mockResolvedValue([]);
  hooksModule.hooks.reset();
});

function sqlTextOf(call = 0): string {
  return JSON.stringify(dbExecute.mock.calls[call]?.[0] ?? {}).replace(/\\n/g, ' ');
}

describe('resolveNotifications', () => {
  it('marks matching unresolved rows read and emits notificationRead per row', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'n1', user_id: 'u1', was_unread: true },
      { id: 'n2', user_id: 'u2', was_unread: true },
    ]);
    const seen: Array<{ id: string; user: string }> = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push({ id: p.notificationId, user: p.userId });
    });

    const count = await resolveNotifications('issue:abc:status');

    expect(count).toBe(2);
    const text = sqlTextOf();
    expect(text).toMatch(/SET read = true, resolved_at = now\(\)/);
    expect(text).toMatch(/resolved_at IS NULL/);
    // cm:guard the lock is the whole fix — without FOR UPDATE two clearers of the same key both read the row unread and both emit, double-decrementing the operator's unread badge. `paused:<runId>` (ISS-879) is the first key with two clearers.
    expect(text).toMatch(/FOR UPDATE/);
    expect(seen).toEqual([
      { id: 'n1', user: 'u1' },
      { id: 'n2', user: 'u2' },
    ]);
  });

  // cm:guard this pair is the reason the filter moved off `read` — a row the operator had already opened still needs its `resolvedAt` stamp, because emitPipelineWedge's dedupe reads that column and would otherwise suppress the next wedge for the same entity forever
  it('stamps an ALREADY-READ row and does not re-emit notificationRead for it', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'n1', user_id: 'u1', was_unread: false }]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationRead', (p) => {
      seen.push(p.notificationId);
    });

    expect(await resolveNotifications('issue:abc:status')).toBe(1);
    expect(seen).toEqual([]);
  });

  it('is idempotent — no unresolved rows clears nothing and emits nothing', async () => {
    dbExecute.mockResolvedValueOnce([]);
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
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('never throws when the db update fails (best-effort)', async () => {
    dbExecute.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveNotifications('issue:abc:status')).resolves.toBe(0);
  });
});
