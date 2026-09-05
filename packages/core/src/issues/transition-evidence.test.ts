/**
 * `checkTransitionEvidence` / `planRequiredRule` — ISS-819 requirement 1: an
 * issue must not reach `approved` with a blank `plan` when the project's
 * plan stage is live. Device actors only (a human hand-advance is a
 * recorded human decision); `skip:true` exempts the orchestrator's curated
 * soft-skip/failover chain.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// cm:why the mock returns null (= evidence found) by default because this suite owns the rule's WIRING — status gate, actorType/skip scope, error shape — while `pipeline/work-evidence.test.ts` owns what counts as evidence; a suite that re-tested both would go red twice for one change.
const findMissingWorkEvidenceMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...(args as [])),
}));

const { checkTransitionEvidence, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

const planRow = (plan: string | null) => [{ plan }];
const projectRow = (pipelineConfig: unknown) => [{ agentConfig: { pipelineConfig } }];

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
