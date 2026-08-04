import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const insertValues: Array<Record<string, unknown>> = [];
let insertReturn: unknown[] = [{ id: 'ticket-1' }];
const updateWhere = vi.fn();
let updateReturn: unknown[] = [];

vi.mock('../db/client.js', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertValues.push(v);
        return { returning: async () => insertReturn };
      },
    }),
    update: () => ({
      set: (s: unknown) => ({
        where: (w: unknown) => {
          updateWhere(s, w);
          return { returning: async () => updateReturn };
        },
      }),
    }),
    delete: () => ({ where: () => ({ returning: async () => [{ id: 'a' }, { id: 'b' }] }) }),
  },
}));

const {
  createDownloadTicket,
  resolveDownloadTicket,
  purgeExpiredDownloadTickets,
  DOWNLOAD_TICKET_TTL_MS,
} = await import('./download-ticket-service.js');

const INPUT = {
  targetType: 'comment' as const,
  attachmentId: 'att-1',
  projectId: 'proj-1',
  issuedToUserId: 'user-1',
  issuedToDeviceId: 'dev-1',
};

describe('createDownloadTicket', () => {
  it('mints a ticket with a short TTL', async () => {
    insertValues.length = 0;
    insertReturn = [{ id: 'ticket-1' }];
    const before = Date.now();
    const out = await createDownloadTicket(INPUT);

    expect(out.id).toBe('ticket-1');
    const ttl = out.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DOWNLOAD_TICKET_TTL_MS + 50);
  });

  // cm:guard the TTL is the ONLY containment for a credential that travels in a URL — a long-lived ticket is a permanent public link to tenant bytes
  it('keeps the TTL well under an hour', () => {
    expect(DOWNLOAD_TICKET_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('records who it was issued to', async () => {
    insertValues.length = 0;
    await createDownloadTicket(INPUT);
    expect(insertValues[0]).toMatchObject({
      targetType: 'comment',
      attachmentId: 'att-1',
      projectId: 'proj-1',
      issuedToUserId: 'user-1',
      issuedToDeviceId: 'dev-1',
    });
  });

  it('throws when the insert returns nothing', async () => {
    insertReturn = [];
    await expect(createDownloadTicket(INPUT)).rejects.toThrow('failed to create download ticket');
  });
});

describe('resolveDownloadTicket', () => {
  it('returns the target and counts the fetch', async () => {
    updateReturn = [{ targetType: 'issue', attachmentId: 'att-9', projectId: 'proj-9' }];
    const out = await resolveDownloadTicket('ticket-1');
    expect(out).toEqual({ targetType: 'issue', attachmentId: 'att-9', projectId: 'proj-9' });
    const set = updateWhere.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(set.fetchCount).toBeDefined();
    expect(set.lastFetchedAt).toBeDefined();
  });

  // cm:guard resolution must NOT consume the ticket — a third-party fetcher retries, and burning it on the first attempt recreates the dead end this whole mechanism removes
  it('does not mark the ticket consumed', async () => {
    updateReturn = [{ targetType: 'issue', attachmentId: 'att-9', projectId: 'proj-9' }];
    await resolveDownloadTicket('ticket-1');
    const set = updateWhere.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect('consumedAt' in set).toBe(false);
  });

  it('returns null for an unknown or expired ticket', async () => {
    updateReturn = [];
    expect(await resolveDownloadTicket('nope')).toBeNull();
  });
});

describe('purgeExpiredDownloadTickets', () => {
  it('reports how many it removed', async () => {
    expect(await purgeExpiredDownloadTickets()).toBe(2);
  });
});
