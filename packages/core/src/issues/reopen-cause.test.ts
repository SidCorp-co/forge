/**
 * ISS-927 (REQ-67 BC-6): a reopen's cause is read from its field alone. Only a move to `reopen` takes
 * `cause` or `evidence`; `cause: defect` cites its evidence, and evidence says it is a defect's.
 *
 * @direct-test-of packages/core/src/issues/reopen-cause.ts
 */

import { describe, expect, it } from 'vitest';
import { reopenCauseShapeFault } from './reopen-cause.js';

const evidence = { liveRead: 'the total cell is empty' };

describe('reopenCauseShapeFault', () => {
  it('passes a plain move and a defect reopen with its evidence', () => {
    expect(reopenCauseShapeFault('reopen', {})).toBeNull();
    expect(reopenCauseShapeFault('on_hold', {})).toBeNull();
    expect(reopenCauseShapeFault('reopen', { cause: 'defect', evidence })).toBeNull();
  });

  it('refuses a cause or evidence on any target but reopen, naming the fields sent', () => {
    for (const to of [
      'on_hold',
      'needs_info',
      'dropped',
      'in_progress',
      'awaiting_release',
    ] as const) {
      expect(reopenCauseShapeFault(to, { cause: 'defect', evidence })?.code).toBe(
        'CAUSE_NOT_APPLICABLE',
      );
    }
    expect(reopenCauseShapeFault('on_hold', { evidence })?.details).toMatchObject({
      fields: ['evidence'],
    });
  });

  it('refuses a defect with no evidence, and evidence with no cause, saying the shape it takes', () => {
    const noProof = reopenCauseShapeFault('reopen', { cause: 'defect' });
    expect(noProof?.code).toBe('DEFECT_EVIDENCE_REQUIRED');
    expect(noProof?.detail).toContain('liveRead');
    expect(reopenCauseShapeFault('reopen', { evidence })?.code).toBe('DEFECT_CAUSE_REQUIRED');
  });
});
