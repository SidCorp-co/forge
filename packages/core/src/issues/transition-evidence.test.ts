/**
 * cm:hack the ISS-786 evidence rule, carried onto the retired rungs forge-plugin 3.36.542 still
 * names (ISS-54): an agent naming `developed` or `testing` with nothing recorded is refused, a
 * person is not. Exit: until forge-plugin moves to the 10-status model (plugin-followups.md).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const findMissingWorkEvidenceMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...(args as [])),
}));

const { legacyRungEvidenceFault, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

describe('isBlankPlan', () => {
  it.each([null, undefined, '', '   ', '\n\t'])('treats %j as blank', (v) => {
    expect(isBlankPlan(v)).toBe(true);
  });

  it.each(['a plan', '  a plan  '])('treats %j as non-blank', (v) => {
    expect(isBlankPlan(v)).toBe(false);
  });
});

describe('legacyRungEvidenceFault — the retired code-claiming rungs', () => {
  beforeEach(() => {
    findMissingWorkEvidenceMock.mockReset();
    findMissingWorkEvidenceMock.mockResolvedValue(null);
  });

  it.each(['developed', 'testing'] as const)(
    'refuses an agent naming %s with no recorded evidence',
    async (rung) => {
      findMissingWorkEvidenceMock.mockResolvedValueOnce(
        'no branch, commit or code handoff is recorded',
      );
      const violation = await legacyRungEvidenceFault({ issue: ISSUE, rung, agency: 'agent' });
      expect(violation).toEqual({
        code: 'NO_WORK_EVIDENCE',
        detail: 'no branch, commit or code handoff is recorded',
        details: { issueId: 'iss-1', rung },
      });
    },
  );

  it('allows an agent naming developed when evidence exists', async () => {
    expect(
      await legacyRungEvidenceFault({ issue: ISSUE, rung: 'developed', agency: 'agent' }),
    ).toBeNull();
  });

  it.each(['confirmed', 'clarified', 'tested', 'releasing', null] as const)(
    'never reads evidence for %s — it claims no code',
    async (rung) => {
      findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
      expect(await legacyRungEvidenceFault({ issue: ISSUE, rung, agency: 'agent' })).toBeNull();
      expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
    },
  );

  it('allows a person even with no evidence', async () => {
    findMissingWorkEvidenceMock.mockResolvedValueOnce('missing');
    expect(
      await legacyRungEvidenceFault({ issue: ISSUE, rung: 'developed', agency: 'human' }),
    ).toBeNull();
    expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
  });

  it('refuses the move by throwing when the rule cannot be read, never allows it', async () => {
    findMissingWorkEvidenceMock.mockRejectedValueOnce(new Error('current transaction is aborted'));
    await expect(
      legacyRungEvidenceFault({ issue: ISSUE, rung: 'developed', agency: 'agent' }),
    ).rejects.toThrow('current transaction is aborted');
  });
});
