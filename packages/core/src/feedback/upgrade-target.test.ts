import { describe, expect, it } from 'vitest';
import { upgradeTargetRefusal } from './rules.js';

describe('a contract change routed to an existing issue (requirement-to-delivery triage)', () => {
  it('writes its wait on a live issue holding no wait on the contract', () => {
    expect(upgradeTargetRefusal({ key: 'HOP-4', status: 'open' }, null)).toBeNull();
  });

  it('refuses a finished issue by name, since it would never be dispatched to adapt', () => {
    const r = upgradeTargetRefusal({ key: 'HOP-4', status: 'closed' }, null);
    expect(r?.code).toBe('CONTRACT_WAIT_ISSUE_FINISHED');
    expect(r?.detail).toContain('HOP-4 is closed');
  });

  it('refuses an issue already waiting on the contract rather than folding the deadline into its wait', () => {
    const r = upgradeTargetRefusal(
      { key: 'HOP-4', status: 'open' },
      { id: 'w1', minVersion: '1.0.0', contractSlug: 'orders' },
    );
    expect(r?.code).toBe('CONTRACT_WAIT_DUPLICATE');
    expect(r?.detail).toContain('orders >= 1.0.0 (wait w1)');
  });
});
