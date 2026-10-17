/**
 * ISS-1337 — the reader that says, before a release is pressed, what its finish's close would
 * refuse each row for. It answers by calling the close's own predicates, mocked here; the whole
 * chain is held against Postgres in `tests/integration/release-roster-unclosable-e2e.test.ts`.
 */

import { markMergedSteps } from '@forge/contracts/mark-merged-words';
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

const { ENTRY_RECORDS_CLEAR, rosterCloseShortfalls, shortfallLine, shortfallSaid } = await import(
  './close-shortfall.js'
);

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
    // Repair 1 — the field is named as the page labels it, read from the page's own words.
    expect(found?.clears).toBe(markMergedSteps(true));
    expect(unshipped).toHaveBeenCalledWith({}, { issueId: 'a', toStatus: 'closed' });
  });

  it('names a missing merge on the git shape, which the refusal does not label', async () => {
    unshipped.mockResolvedValue({ detail: 'no merged_at', details: { requires: 'mergedAt' } });
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found).toMatchObject({ reason: 'not marked merged', details: { shape: 'git' } });
    expect(found?.clears).toBe(markMergedSteps(false));
  });

  it('names open questions with the sentence the close prints', async () => {
    asked.mockResolvedValue(['q-1', 'q-2']);
    const [found] = (await rosterCloseShortfalls(PROJECT, ['a'])).get('a') ?? [];
    expect(found?.code).toBe('OPEN_QUESTIONS');
    expect(found?.reason).toBe('holds 2 open questions');
    // The issue page offers answering and nothing that voids a question (ISS-1381 r3).
    expect(found?.clears).toBe(
      'Answer them in their "Decision waiting" cards on the issue\'s page.',
    );
    // On the issue's own page the cards sit right above the banner (ISS-1421 r5 repair 1).
    expect(found?.clearsHere).toBe('Answer them in the Decision waiting cards above.');
    expect(found?.clearsHere).not.toMatch(/issue's page/);
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
      reason: 'missing a plan and a release note, which this project requires before a close',
      clearsHere:
        "An agent writes them through Forge's issue tools. To start one, press Open session at the top of this page.",
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
  it('names the issue, then each reason and what clears it as whole sentences', () => {
    expect(
      shortfallLine('ISS-4', [
        { reason: 'holds 1 open question', clears: 'Answer it.' },
        { reason: 'not marked merged', clears: 'Mark it merged.' },
      ]),
    ).toBe('ISS-4: It holds 1 open question. Answer it. It is not marked merged. Mark it merged.');
  });
});

// ISS-1421 r5: the banner and the gate panel joined `${reason}. ${clears}`, so a second shortfall
// opened lower case after the first one's full stop ("… Where it landed. holds 1 open question.").
describe('shortfallSaid', () => {
  it.each([
    ['not marked merged', 'It is not marked merged.'],
    ['no mark naming where its work landed', 'It has no mark naming where its work landed.'],
    ['holds 2 open questions', 'It holds 2 open questions.'],
    [
      'missing a plan, which this project requires before a close',
      'It is missing a plan, which this project requires before a close.',
    ],
  ])('says "%s" as a sentence of its own, ahead of what clears it', (reason, sentence) => {
    const said = shortfallSaid({ reason, clears: 'Do this.' });
    expect(said).toBe(`${sentence} Do this.`);
    for (const s of said.split(/(?<=\.)\s+/)) {
      expect(s).toMatch(/^[A-Z]/);
      expect(s).toMatch(/\.$/);
    }
  });

  it('names who writes a missing record, and the door that starts one where none is working', () => {
    expect(ENTRY_RECORDS_CLEAR).toBe(
      "An agent writes them through Forge's issue tools. To start one, press Open session at the top of the issue's page.",
    );
    expect(ENTRY_RECORDS_CLEAR).not.toMatch(/agent working this issue/);
  });
});
