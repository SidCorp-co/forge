/**
 * ISS-1337 — the reader that says, before a release is pressed, what its finish's close would
 * refuse each row for. It answers by calling the close's own predicates, mocked here; the whole
 * chain is held against Postgres in `tests/integration/release-roster-unclosable-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const unshipped = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('../issues/merged-at.js', () => ({
  refuseUnshippedClose: (...a: unknown[]) => unshipped(...a),
}));

const asked = vi.fn(async (..._a: unknown[]) => [] as string[]);
vi.mock('../questions/issue-coupling.js', async (importActual) => ({
  ...(await importActual<typeof import('../questions/issue-coupling.js')>()),
  openQuestionIdsOn: (...a: unknown[]) => asked(...a),
}));

const declared = vi.fn(async (..._a: unknown[]) => [] as string[]);
vi.mock('../issues/entry-criteria.js', () => ({
  resolveDeclaredEntryCriteria: (...a: unknown[]) => declared(...a),
}));

const evidence = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('../issues/transition-evidence.js', () => ({
  checkTransitionEvidence: (...a: unknown[]) => evidence(...a),
}));

const { rosterCloseShortfalls, shortfallLine } = await import('./close-shortfall.js');

const PROJECT = 'p-1';

beforeEach(() => {
  vi.clearAllMocks();
  unshipped.mockResolvedValue(null);
  asked.mockResolvedValue([]);
  declared.mockResolvedValue([]);
  evidence.mockResolvedValue(null);
});

describe('rosterCloseShortfalls', () => {
  it('leaves out a row whose close stands', async () => {
    expect(await rosterCloseShortfalls(PROJECT, ['a'])).toEqual(new Map());
  });

  it('reads nothing for an empty roster', async () => {
    expect(await rosterCloseShortfalls(PROJECT, [])).toEqual(new Map());
    expect(declared).not.toHaveBeenCalled();
  });

  it('names a landing the close would refuse outside git, in the landing words', async () => {
    unshipped.mockResolvedValue({ detail: 'no landing', details: { shape: 'outside_git' } });
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found).toMatchObject({
      code: 'CLOSE_REQUIRES_SHIPPED',
      reason: 'no mark naming where its work landed',
      detail: 'no landing',
      details: { shape: 'outside_git' },
    });
    expect(found?.clears).toContain('landing');
    expect(unshipped).toHaveBeenCalledWith({}, { issueId: 'a', toStatus: 'closed' });
  });

  it('names a missing merge on the git shape, which the refusal does not label', async () => {
    unshipped.mockResolvedValue({ detail: 'no merged_at', details: { requires: 'mergedAt' } });
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found).toMatchObject({ reason: 'not marked merged', details: { shape: 'git' } });
  });

  it('names open questions with the sentence the close prints', async () => {
    asked.mockResolvedValue(['q-1', 'q-2']);
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found?.code).toBe('OPEN_QUESTIONS');
    expect(found?.reason).toBe('holds 2 open questions');
    expect(found?.clears).toMatch(/^Answer them, or void them/);
    expect(found?.detail).toContain('this issue holds 2 open questions (q-1, q-2)');
    expect(found?.details).toEqual({ to: 'closed', openQuestionIds: ['q-1', 'q-2'] });
  });

  it('names the records this project declares for `closed` that the row is missing', async () => {
    declared.mockResolvedValue(['plan', 'release_note']);
    evidence.mockResolvedValue({
      code: 'ENTRY_CRITERIA_UNMET',
      detail: 'needs a plan',
      details: { unmet: ['plan', 'release_note'] },
    });
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found).toMatchObject({
      code: 'ENTRY_CRITERIA_UNMET',
      reason: 'missing what this project requires to close: plan, release_note',
    });
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: { id: 'a', projectId: PROJECT },
        toStatus: 'closed',
        skip: false,
        declaredCriteria: ['plan', 'release_note'],
      }),
    );
  });

  it('reads the declaration once for the whole roster and keeps every shortfall a row has', async () => {
    unshipped.mockImplementation(async (_x, a) =>
      (a as { issueId: string }).issueId === 'b' ? { detail: 'x', details: {} } : null,
    );
    asked.mockImplementation(async (_x, id) => (id === 'b' ? ['q-1'] : []));

    const found = await rosterCloseShortfalls(PROJECT, ['a', 'b', 'c']);

    expect([...found.keys()]).toEqual(['b']);
    expect(found.get('b')?.map((s) => s.code)).toEqual([
      'CLOSE_REQUIRES_SHIPPED',
      'OPEN_QUESTIONS',
    ]);
    expect(declared).toHaveBeenCalledTimes(1);
  });

  it('throws a read that failed rather than answering that the close stands', async () => {
    asked.mockRejectedValue(new Error('questions table unreadable'));
    await expect(rosterCloseShortfalls(PROJECT, ['a'])).rejects.toThrow(
      'questions table unreadable',
    );
  });
});

describe('shortfallLine', () => {
  it('names the issue, each reason and what clears it', () => {
    expect(
      shortfallLine('ISS-4', [
        { reason: 'holds 1 open question', clears: 'Answer it.' },
        { reason: 'not marked merged', clears: 'Mark it merged.' },
      ]),
    ).toBe('ISS-4: holds 1 open question. Answer it. not marked merged. Mark it merged.');
  });
});
