import { describe, expect, it } from 'vitest';
import { approverRefusal, decisionRefusals } from './approval.js';

const P = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const agent = { userId: 'a', agency: 'agent' as const, role: 'member' as const, orgRole: null };
const admin = { userId: 'p', agency: 'human' as const, role: null, orgRole: 'admin' as const };
const member = {
  userId: 'm',
  agency: 'human' as const,
  role: 'admin' as const,
  orgRole: 'member' as const,
};
const v = (classification: string) => ({ ref: 'hop/postcare-api@1.1.0', classification });

describe('who decides a contract version', () => {
  it('lets an org admin person decide any version, breaking included', () => {
    expect(approverRefusal(admin, v('breaking'), 'owner', P)).toBeNull();
  });

  it('refuses a person who is not an org admin', () => {
    expect(approverRefusal(member, v('non-breaking'), 'master', P)?.code).toBe(
      'CONTRACT_APPROVER_NOT_ADMIN',
    );
  });

  it('lets the project agent approve a non-breaking or initial version under approver master', () => {
    expect(approverRefusal(agent, v('non-breaking'), 'master', P)).toBeNull();
    expect(approverRefusal(agent, v('initial'), 'master', P)).toBeNull();
  });

  it.each(['breaking', 'unknown'])(
    'refuses the agent a %s version even under approver master',
    (classification) => {
      expect(approverRefusal(agent, v(classification), 'master', P)?.code).toBe(
        'CONTRACT_BREAKING_NEEDS_PERSON',
      );
    },
  );

  it('refuses the agent any version under approver owner', () => {
    expect(approverRefusal(agent, v('non-breaking'), 'owner', P)?.code).toBe(
      'CONTRACT_APPROVER_NOT_PERSON',
    );
  });

  it("refuses another project's agent", () => {
    expect(approverRefusal({ ...agent, role: null }, v('non-breaking'), 'master', P)?.code).toBe(
      'CONTRACT_APPROVER_NOT_PROJECT',
    );
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
