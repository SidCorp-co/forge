import { statusesForLabels } from '@forge/contracts/issue-vocabulary';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: { select: () => ({}) } }));

const { AWAITING_INPUT_STATUSES } = await import('./attention-buckets.js');

describe('the bucket and the label axis', () => {
  it('name the same statuses, in the same order', () => {
    expect([...AWAITING_INPUT_STATUSES]).toEqual(statusesForLabels('needs_human'));
  });

  it('agree that a deliberate pause is not a question', () => {
    expect(AWAITING_INPUT_STATUSES).not.toContain('on_hold');
    expect(statusesForLabels('needs_human')).not.toContain('on_hold');
    expect(statusesForLabels('paused')).toEqual(['on_hold']);
  });

  it('agree on both statuses that DO ask a human', () => {
    expect(AWAITING_INPUT_STATUSES).toContain('waiting');
    expect(AWAITING_INPUT_STATUSES).toContain('needs_info');
  });
});
