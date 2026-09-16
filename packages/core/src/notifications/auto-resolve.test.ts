import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn();

// `db.select` answers no rows, so `sendResolvedNotice` finds no record and returns
// without announcing anything: these cases stay about the UPDATE and its lock, which is
// what this unit owns. The notice itself is exercised against a real database in
// `tests/integration/notification-record-kinds-e2e.test.ts`.
vi.mock('../db/client.js', () => ({
  db: {
    execute: (...a: unknown[]) => dbExecute(...a),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  },
}));

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
  it('stamps every unresolved row carrying the key and reports how many', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'n1', state: 'resolved' },
      { id: 'n2', state: 'resolved' },
    ]);

    const count = await resolveNotifications('issue:abc:status');

    expect(count).toBe(2);
    const text = sqlTextOf();
    // cm:guard ISS-1063 — this statement must NOT touch `read`: the column is not on this table any more, and the whole issue is that resolving a record and a person reading it are different facts. A future edit that re-adds a read write here fails on this line.
    expect(text).not.toMatch(/read/);
    expect(text).toMatch(/SET resolved_at = now\(\)/);
    expect(text).toMatch(/resolved_at IS NULL/);
    // cm:guard the lock is the whole fix — without FOR UPDATE two clearers of the same key can both claim the row and both announce it cleared. `paused:<runId>` (ISS-879) is the first key with two clearers.
    expect(text).toMatch(/FOR UPDATE/);
  });

  // cm:guard the condition's own state moves with the stamp — a `firing` row left firing while `resolved_at` is set is the state lying in the one place ISS-1063 made the open count read from
  it('moves a condition to `resolved` and leaves other kinds their state', async () => {
    dbExecute.mockResolvedValueOnce([{ id: 'n1', state: 'resolved' }]);
    expect(await resolveNotifications('issue:abc:status')).toBe(1);
    expect(sqlTextOf()).toMatch(/state = CASE WHEN n.kind = 'condition' THEN 'resolved'/);
  });

  it('is idempotent — no unresolved rows clears nothing and announces nothing', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const seen: string[] = [];
    hooksModule.hooks.on('notificationCreated', (p) => {
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
