// A defer and the undefer that undoes it are each a person's act with a reason: both are refused
// without one, by name, so the history says why a requirement crossed the release line either way.

import { describe, expect, it } from 'vitest';
import { deferRefusals, undeferRefusals } from './deferral-rules.js';

const codes = (rows: { code: string }[]) => rows.map((r) => r.code);

describe('the reason a requirement crosses the release line', () => {
  it('refuses an undefer without a reason, as a defer is refused without one', () => {
    for (const reason of [undefined, null, '', '   ']) {
      expect(codes(deferRefusals({ status: 'agreed', reason, workingIssues: [] }))).toEqual([
        'REQUIREMENT_DEFER_REASON_REQUIRED',
      ]);
      expect(undeferRefusals({ status: 'deferred', reason })).toEqual([
        expect.objectContaining({ code: 'REQUIREMENT_UNDEFER_REASON_REQUIRED', path: '/reason' }),
      ]);
    }
  });

  it('takes an undefer with a reason, and still refuses one of a requirement not deferred', () => {
    expect(undeferRefusals({ status: 'deferred', reason: 'planned into v1' })).toEqual([]);
    expect(codes(undeferRefusals({ status: 'agreed', reason: 'planned into v1' }))).toEqual([
      'REQUIREMENT_NOT_DEFERRED',
    ]);
    expect(codes(undeferRefusals({ status: 'draft', reason: '' }))).toEqual([
      'REQUIREMENT_NOT_DEFERRED',
      'REQUIREMENT_UNDEFER_REASON_REQUIRED',
    ]);
  });
});
