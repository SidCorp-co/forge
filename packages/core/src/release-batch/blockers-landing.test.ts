/**
 * What the finish's close would refuse, reported before the press at both doors (ISS-1327, ISS-1337).
 *
 * A landing the close would refuse is `RELEASE_WORK_UNMERGED`, worded for the issue's shape; any
 * other refusal it would make is `RELEASE_ISSUES_UNCLOSABLE`, naming each issue and what clears it.
 * The refusals themselves are `close-shortfall.ts`'s, mocked here; that reader is held against
 * Postgres in `tests/integration/release-roster-unclosable-e2e.test.ts`. Beside `blockers.test.ts`,
 * with its mocks, because that file is at its size budget.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
const fromChain: Record<string, unknown> = {};
fromChain.where = () => Object.assign(selectRows(), { limit: selectLimit });
fromChain.innerJoin = fromChain.leftJoin = () => fromChain;
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => fromChain }), execute: async () => [] },
}));

vi.mock('../integrations/store.js', async (importActual) => ({
  ...(await importActual<typeof import('../integrations/store.js')>()),
  listActiveDeployBindingsForStage: async () => [
    {
      binding: { id: 'b-1', provider: 'coolify', config: {}, instructions: null, label: '' },
      connection: { config: {} },
    },
  ],
}));
vi.mock('../runners/select.js', () => ({ onlineCapableDeviceIds: async () => [] }));
vi.mock('./queries.js', async (importActual) => ({
  ...(await importActual<typeof import('./queries.js')>()),
  getActiveReleaseBatch: async () => null,
}));
const missingNotes = vi.fn(async () => [] as string[]);
vi.mock('../issues/release-record-required.js', async (importActual) => ({
  ...(await importActual<typeof import('../issues/release-record-required.js')>()),
  issuesMissingReleaseRecord: () => missingNotes(),
}));
const SHOWN: Record<string, string> = {
  '66666666-6666-4666-8666-666666666666': 'ISS-1',
  '77777777-7777-4777-8777-777777777777': 'ISS-2',
};
vi.mock('../issues/display-ids.js', () => ({
  issueDisplayIds: async (ids: string[]) => new Map(ids.map((id) => [id, SHOWN[id] ?? id])),
}));

const closeShortfalls = vi.fn(async (..._a: unknown[]) => new Map() as Map<string, unknown[]>);
vi.mock('./close-shortfall.js', () => ({
  rosterCloseShortfalls: (...a: unknown[]) => closeShortfalls(...a),
}));

const { collectReleaseBlockers, releaseBlockerError } = await import('./blockers.js');
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ISSUE = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';

const LANDING_OUTSIDE = {
  code: 'CLOSE_REQUIRES_SHIPPED',
  reason: 'no mark naming where its work landed',
  clears: 'Mark it merged with its landing.',
  detail: 'x',
  details: { shape: 'outside_git' },
};
const LANDING_GIT = { ...LANDING_OUTSIDE, reason: 'not marked merged', details: { shape: 'git' } };
const QUESTION = {
  code: 'OPEN_QUESTIONS',
  reason: 'holds 1 open question',
  clears: 'Answer it, or void it with the reason it died with the work.',
  detail: 'x',
  details: { openQuestionIds: ['q-1'] },
};
const DECLARED = {
  code: 'ENTRY_CRITERIA_UNMET',
  reason: 'missing what this project requires to close: plan',
  clears: 'Write each missing record on the issue.',
  detail: 'x',
  details: { unmet: ['plan'] },
};

beforeEach(() => {
  selectLimit.mockResolvedValue([
    { repoPath: null, repoUrl: null, baseBranch: 'main', releaseChain: [{ branch: 'main' }] },
  ]);
  selectRows.mockResolvedValue([
    { id: ISSUE, status: 'awaiting_release', claimed: null },
    { id: OTHER, status: 'awaiting_release', claimed: null },
  ]);
  closeShortfalls.mockReset();
  closeShortfalls.mockResolvedValue(new Map());
  missingNotes.mockResolvedValue([]);
});

async function blockersAt(door: 'record' | 'batch', refused: Map<string, unknown[]>) {
  closeShortfalls.mockResolvedValue(refused);
  const { blockers } = await collectReleaseBlockers(PROJECT_ID, {
    issueIds: [ISSUE, OTHER],
    door,
  });
  return blockers.filter((b) => b.scope !== 'roster' && b.code !== 'RELEASE_POOL_EMPTY');
}

describe('RELEASE_WORK_UNMERGED, before the press at either door', () => {
  it.each(['record', 'batch'] as const)(
    'names an issue whose mark names no landing in the landing sentence at the %s door',
    async (door) => {
      const blockers = await blockersAt(door, new Map([[ISSUE, [LANDING_OUTSIDE]]]));
      const unmerged = blockers.find((b) => b.code === 'RELEASE_WORK_UNMERGED');
      expect(unmerged?.details).toMatchObject({ issueIds: [ISSUE], shape: 'outside_git' });
      expect(unmerged?.message).toContain('`landing`');
      expect(unmerged?.message).not.toMatch(/branch/);
      expect(blockers.map((b) => b.code)).not.toContain('RELEASE_ISSUES_UNCLOSABLE');
    },
  );

  it('keeps the git sentence, which names the branch, on a project that lands in git', async () => {
    const blockers = await blockersAt('batch', new Map([[ISSUE, [LANDING_GIT]]]));
    const unmerged = blockers.find((b) => b.code === 'RELEASE_WORK_UNMERGED');
    expect(unmerged?.details).toMatchObject({ issueIds: [ISSUE], shape: 'git' });
    expect(unmerged?.message).toContain('the branch this release deployed');
  });

  it('asks the record door for a merge and never for a runner', async () => {
    closeShortfalls.mockResolvedValue(new Map([[ISSUE, [LANDING_GIT]]]));
    const { blockers } = await collectReleaseBlockers(PROJECT_ID, {
      issueIds: [ISSUE],
      door: 'record',
    });
    const codes = blockers.map((b) => b.code);
    expect(codes).toContain('RELEASE_WORK_UNMERGED');
    expect(codes).not.toContain('RELEASE_POOL_EMPTY');
    expect(codes).not.toContain('NO_RUNNER_ONLINE');
  });

  it('names the note and the merge together, which the record door met minutes apart', async () => {
    missingNotes.mockResolvedValue([ISSUE]);
    closeShortfalls.mockResolvedValue(new Map([[ISSUE, [LANDING_GIT]]]));
    const err = releaseBlockerError(
      await collectReleaseBlockers(PROJECT_ID, { issueIds: [ISSUE], door: 'record' }),
    );
    expect(err?.name).toBe('ReleaseRecordMissingError');
    expect(err?.releaseBlockers?.map((b) => b.code)).toContain('RELEASE_WORK_UNMERGED');
  });

  it('names neither code for a roster whose every close stands', async () => {
    const codes = (await blockersAt('batch', new Map())).map((b) => b.code);
    expect(codes).not.toContain('RELEASE_WORK_UNMERGED');
    expect(codes).not.toContain('RELEASE_ISSUES_UNCLOSABLE');
  });
});

describe('RELEASE_ISSUES_UNCLOSABLE, before the press at either door', () => {
  it.each(['record', 'batch'] as const)(
    'names each issue, its reason and what clears it, at the %s door',
    async (door) => {
      const blockers = await blockersAt(
        door,
        new Map([
          [ISSUE, [QUESTION]],
          [OTHER, [DECLARED]],
        ]),
      );
      const unclosable = blockers.find((b) => b.code === 'RELEASE_ISSUES_UNCLOSABLE');
      expect(unclosable?.httpStatus).toBe(409);
      expect(unclosable?.details).toMatchObject({
        issueIds: [ISSUE, OTHER],
        displayIds: ['ISS-1', 'ISS-2'],
      });
      expect(unclosable?.message).toContain('`ISS-1` holds 1 open question (OPEN_QUESTIONS)');
      expect(unclosable?.message).toContain('Answer it');
      expect(unclosable?.message).toContain(
        '`ISS-2` missing what this project requires to close: plan',
      );
      expect(unclosable?.message).toContain('leave the issue off this release');
    },
  );

  it('splits one issue refused for its landing and a question across the two codes', async () => {
    const blockers = await blockersAt('batch', new Map([[ISSUE, [LANDING_OUTSIDE, QUESTION]]]));
    const codes = blockers.map((b) => b.code);
    expect(codes.indexOf('RELEASE_WORK_UNMERGED')).toBeLessThan(
      codes.indexOf('RELEASE_ISSUES_UNCLOSABLE'),
    );
    const unclosable = blockers.find((b) => b.code === 'RELEASE_ISSUES_UNCLOSABLE');
    expect(unclosable?.message).not.toContain('CLOSE_REQUIRES_SHIPPED');
  });

  it('reports the close check it could not run, never a roster whose close stands', async () => {
    closeShortfalls.mockRejectedValue(new Error('questions table unreadable'));
    const { blockers } = await collectReleaseBlockers(PROJECT_ID, {
      issueIds: [ISSUE],
      door: 'batch',
    });
    const unevaluated = blockers.find(
      (b) => b.code === 'RELEASE_CHECK_UNEVALUATED' && b.details?.check === 'close',
    );
    expect(unevaluated?.evaluated).toBe(false);
  });
});
