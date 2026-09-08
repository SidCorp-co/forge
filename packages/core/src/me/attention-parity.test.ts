/**
 * `AWAITING_INPUT_STATUSES` and the contracts label axis must name the same
 * statuses.
 *
 * The bucket answers one question — which statuses are a question for a human —
 * and `@forge/contracts/issue-vocabulary` answers the same one for every client.
 * Core cannot value-import that package (absent from the production image; a
 * value import compiles green then crashes at boot — `contracts-runtime-
 * boundary.test.ts`, ISS-510), so the list exists twice and this file is the
 * only thing standing between that and drift. A test-time value import is the
 * sanctioned shape: test files never reach `dist`, which is why the boundary
 * guard skips them — the same arrangement `pipeline/failure-causes-parity.test.ts`
 * uses.
 *
 * ISS-970 is what the drift cost: the bucket held `on_hold` while its own header
 * said "blocked on a human", so every `cancel` with the `parkIssue: true` default
 * minted a row claiming somebody was owed an answer nobody had asked for.
 */

import { statusesForLabels } from '@forge/contracts/issue-vocabulary';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: { select: () => ({}) } }));

const { AWAITING_INPUT_STATUSES } = await import('./attention-buckets.js');

describe('the bucket and the label axis', () => {
  it('name the same statuses, in the same order', () => {
    expect([...AWAITING_INPUT_STATUSES]).toEqual(statusesForLabels('needs_human'));
  });

  // cm:guard the assertion above is a comparison against ANOTHER package's answer, never against this module's own constant — a test that reads the implementation it is checking cannot fail. This case fixes the value the axis is expected to hold, so an edit that moves BOTH sides together still has to say so here.
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
