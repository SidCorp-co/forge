import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_RESOLVED_STATUSES } from '../issues/status-sets.js';

let rows: Array<{ status: string }> = [];
const limit = vi.fn(async () => rows);
const chain = { from: () => chain, where: () => chain, limit };

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const { verifyRecovery } = await import('./recovery-verifier.js');

beforeEach(() => {
  rows = [];
  limit.mockClear();
});

describe('verifyRecovery', () => {
  it.each([...ISSUE_RESOLVED_STATUSES])('an issue at %s → advanced', async (status) => {
    rows = [{ status }];
    expect(await verifyRecovery({ issueId: 'i-1' })).toBe('advanced');
  });

  it.each([
    'open',
    'confirmed',
    'approved',
    'in_progress',
    'developed',
    'testing',
    'needs_info',
    'dropped',
    'waiting',
  ])('an issue at %s → pending, never a stale cancel (ISS-1229)', async (status) => {
    rows = [{ status }];
    expect(await verifyRecovery({ issueId: 'i-1' })).toBe('pending');
    // A historical row of a retired staged type is read the same way: no stage table survives to revert it.
    expect(await verifyRecovery({ issueId: 'i-1', type: 'code' } as never)).toBe('pending');
  });

  it('an issue-less job → pending, with no read', async () => {
    expect(await verifyRecovery({ issueId: null })).toBe('pending');
    expect(limit).not.toHaveBeenCalled();
  });

  it('an issue that no longer exists → pending', async () => {
    expect(await verifyRecovery({ issueId: 'gone' })).toBe('pending');
  });
});
