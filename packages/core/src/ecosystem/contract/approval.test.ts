import { describe, expect, it } from 'vitest';
import { approverRefusal, decisionRefusals } from './approval.js';

const P = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const v = { ref: 'hop/postcare-api@1.1.0' };

describe('who decides a contract version (contracts.approve, ADR 0007)', () => {
  it('lets any holder decide, an agent included, a breaking version included', () => {
    expect(approverRefusal({ userId: 'agent', role: 'admin' }, v, P)).toBeNull();
  });

  it('refuses a member, a viewer or another project by the one permission code', () => {
    for (const role of ['member', 'viewer', null] as const) {
      expect(approverRefusal({ userId: 'a', role }, v, P)).toMatchObject({
        code: 'APPROVE_PERMISSION_REQUIRED',
        permission: 'contracts.approve',
        resource: 'contracts',
      });
    }
  });
});

describe('what may be decided', () => {
  const ref = 'hop/postcare-api@1.1.0';
  it('refuses deciding a version that is not proposed', () => {
    expect(
      decisionRefusals({ ref, approval: 'approved', decision: 'return', reason: 'x' })[0]?.code,
    ).toBe('CONTRACT_VERSION_NOT_PROPOSED');
  });

  it('refuses returning without a reason, and approves without one', () => {
    expect(
      decisionRefusals({ ref, approval: 'proposed', decision: 'return', reason: ' ' })[0]?.code,
    ).toBe('CONTRACT_DECISION_REASON_MISSING');
    expect(
      decisionRefusals({ ref, approval: 'proposed', decision: 'approve', reason: null }),
    ).toEqual([]);
  });
});
