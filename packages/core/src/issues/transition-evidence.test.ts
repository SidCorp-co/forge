/**
 * The rules on the state-machine writer, and WHO each one applies to.
 *
 * `no_work_evidence` holds against an agent only — a human hand-advance is a
 * recorded human decision. `entry_criteria` (ISS-959) holds against every
 * actor, because what the project declared is the project's rule and not a
 * defence against fabrication. `skip:true` exempts the whole checker: that is
 * the orchestrator's curated soft-skip/failover chain.
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

const findUnmetEntryCriteriaMock = vi.fn<() => Promise<{ unmet: unknown[] } | null>>(
  async () => null,
);
vi.mock('./entry-criteria.js', () => ({
  findUnmetEntryCriteria: (...args: unknown[]) => findUnmetEntryCriteriaMock(...(args as [])),
}));

const { checkTransitionEvidence, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

function _setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

const _planRow = (plan: string | null) => [{ plan }];
const _projectRow = (pipelineConfig: unknown) => [{ agentConfig: { pipelineConfig } }];

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
      declaredCriteria: [],
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
      declaredCriteria: [],
    });
    expect(violation?.code).toBe('NO_WORK_EVIDENCE');
  });

  it('allows a device transition to developed when evidence exists', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'agent',
      skip: false,
      declaredCriteria: [],
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
      declaredCriteria: [],
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
      declaredCriteria: [],
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
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });
});

describe('checkTransitionEvidence — entry_criteria rule (ISS-959)', () => {
  beforeEach(() => {
    findMissingWorkEvidenceMock.mockReset();
    findMissingWorkEvidenceMock.mockResolvedValue(null);
    findUnmetEntryCriteriaMock.mockReset();
    findUnmetEntryCriteriaMock.mockResolvedValue(null);
  });

  const shortfall = (...keys: string[]) => ({
    unmet: keys.map((key) => ({ key, detail: `no ${key} is written on this issue` })),
  });

  it('refuses a HUMAN transition on an unmet declared criterion — the half no rule reached before', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(violation?.details).toEqual({
      issueId: ISSUE.id,
      toStatus: 'closed',
      unmet: ['plan'],
    });
  });

  it('refuses an AGENT transition on the same unmet criterion', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'agent',
      skip: false,
      declaredCriteria: ['release_note'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
  });

  it('names the missing record in the detail, and names only what is unmet', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'acceptance_criteria', 'merged_mark'],
    });
    expect(violation?.detail).toContain('no plan is written on this issue');
    expect(violation?.detail).not.toContain('acceptance_criteria');
    expect(violation?.detail).not.toContain('merged_mark');
  });

  it('reads plural and singular from the shortfall it was given', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan', 'release_note'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'release_note'],
    });
    expect(violation?.detail).toContain('records this project declares');
    expect(violation?.detail).toContain('they are missing');
  });

  it('passes a transition whose declared criteria are all met', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan'],
    });
    expect(violation).toBeNull();
  });

  it('is exempt under the orchestrator skip flag, and never even asks', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: true,
      declaredCriteria: ['plan'],
    });
    expect(violation).toBeNull();
    expect(findUnmetEntryCriteriaMock).not.toHaveBeenCalled();
  });

  it('hands the declared list straight through to the criteria reader', async () => {
    await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['plan', 'work_evidence'],
    });
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: ISSUE.id, declared: ['plan', 'work_evidence'] }),
    );
  });

  it('holds a human to `work_evidence` when the project DECLARES it, though the agent-only rule exempts them', async () => {
    findUnmetEntryCriteriaMock.mockResolvedValue(shortfall('work_evidence'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      agency: 'human',
      skip: false,
      declaredCriteria: ['work_evidence'],
    });
    expect(violation?.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('leaves a project that declared nothing byte-for-byte as before: no criteria read at all', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'closed',
      agency: 'human',
      skip: false,
      declaredCriteria: [],
    });
    expect(violation).toBeNull();
    expect(findUnmetEntryCriteriaMock).toHaveBeenCalledWith(
      expect.objectContaining({ declared: [] }),
    );
  });
});
