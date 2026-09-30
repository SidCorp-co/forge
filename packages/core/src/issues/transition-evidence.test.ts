/**
 * The rules on the state-machine writer, and WHO each one applies to.
 *
 * `no_work_evidence` holds against an agent only — a human hand-advance is a
 * recorded human decision. `skip:true` exempts the whole checker: that is the
 * orchestrator's curated soft-skip/failover chain.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const findMissingWorkEvidenceMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...(args as [])),
}));

const { checkTransitionEvidence, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

describe('isBlankPlan', () => {
  it.each([null, undefined, '', '   ', '\n\t'])('treats %j as blank', (v) => {
    expect(isBlankPlan(v)).toBe(true);
  });

  it.each(['a plan', '  a plan  '])('treats %j as non-blank', (v) => {
    expect(isBlankPlan(v)).toBe(false);
  });
});

describe('checkTransitionEvidence — no_work_evidence rule', () => {
  beforeEach(() => {
    findMissingWorkEvidenceMock.mockReset();
    findMissingWorkEvidenceMock.mockResolvedValue(null);
  });

  it('blocks a device transition to developed with no recorded evidence', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce(
      'no branch, commit or code handoff is recorded',
    );
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: false,
    });
    expect(violation).toEqual({
      code: 'NO_WORK_EVIDENCE',
      detail: 'no branch, commit or code handoff is recorded',
      details: { issueId: 'iss-1', toStatus: 'developed' },
    });
  });

  it('blocks a device transition to testing with no recorded evidence', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'testing',
      agency: 'agent',
      skip: false,
    });
    expect(violation?.code).toBe('NO_WORK_EVIDENCE');
  });

  it('allows a device transition to developed when evidence exists', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  it('never checks evidence for closed/released — not claiming statuses', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('allows a user actor even with no evidence (device-only enforcement)', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'human',
      skip: false,
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('allows options.skip:true (auto-skip/failover chain unaffected)', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: true,
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });
});

describe('checkTransitionEvidence — a rule that cannot be read', () => {
  beforeEach(() => {
    findMissingWorkEvidenceMock.mockReset();
  });

  it('refuses the transition by throwing, never allows it', async () => {
    findMissingWorkEvidenceMock.mockRejectedValueOnce(new Error('current transaction is aborted'));
    await expect(
      checkTransitionEvidence({
        issue: ISSUE,
        toStatus: 'developed',
        agency: 'agent',
        skip: false,
      }),
    ).rejects.toThrow('current transaction is aborted');
  });
});
