/**
 * ISS-1337 — the unattended sweep leaves off a waiting row whose close its release's finish would
 * refuse, writes why on that row, and still cuts the rest. Beside `release-sweep.test.ts`, which is
 * at its size budget, with only the mocks this question needs; held against Postgres in
 * `tests/integration/release-sweep-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSweepCursorsForTest } from './sweep-cursor.js';

let candidateRows: Array<{ id: string; project_id: string; cursor_ts: string }> = [];
let waitingIds: string[] = [];
vi.mock('../db/client.js', () => ({
  db: {
    execute: async () => candidateRows,
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([]), {
            orderBy: async () => waitingIds.map((id) => ({ id })),
          }),
      }),
    }),
  },
}));
vi.mock('../db/schema.js', () => ({ comments: {}, issues: {} }));

type Hold = { code: string; reason: string; owes: string; waitingFor: string };
let holds: Record<string, Hold> = {};
vi.mock('./release-hold.js', async () => ({
  ...(await vi.importActual<typeof import('./release-hold.js')>('./release-hold.js')),
  writeReleaseHolds: async (args: { issueIds: string[]; holdFor: (id: string) => Hold }) => {
    for (const id of args.issueIds) holds[id] = args.holdFor(id);
    return { written: args.issueIds.length, unchanged: 0, skipped: 0 };
  },
  clearReleaseHolds: async (ids: string[]) => ids.length,
  clearProjectReleaseHolds: async () => 0,
  clearStaleReleaseHolds: async () => 0,
}));
vi.mock('./release-coolify.js', () => ({ projectAutoProdDeploy: async () => true }));
vi.mock('../release-batch/gate.js', () => ({
  RELEASE_GATE_STATUS: 'awaiting_release',
  ReleaseTargetUndeclaredError: class extends Error {},
  resolveReleaseGate: async () => 'awaiting_release',
}));
vi.mock('../issues/criteria-verdicts.js', () => ({
  unearnedCriteriaReports: async (ids: string[]) =>
    ids.map((issueId) => ({ issueId, unearned: [], uncorroborated: [], runtimes: [] })),
}));
vi.mock('../release-batch/serving-reading.js', async (importActual) => ({
  ...(await importActual<object>()),
  readServingNow: async () => ({ kind: 'serving', served: [], unread: [], readAt: 'T' }),
}));
vi.mock('../release-batch/runtime-weighing.js', () => ({ readWeighingNow: async () => null }));
vi.mock('../schedules/release-batch-dispatch.js', () => ({ loadCreatedBy: async () => 'owner-1' }));

const cut = vi.fn(async (args: { issueIds: string[] }) => ({
  status: 'success' as const,
  output: 'cut',
  named: args.issueIds,
}));
vi.mock('../schedules/release-batch-run.js', () => ({
  cutWaitingRelease: (args: { issueIds: string[] }) => cut(args),
}));

const closeShortfalls = vi.fn(async (..._a: unknown[]) => new Map() as Map<string, unknown[]>);
vi.mock('../release-batch/close-shortfall.js', () => ({
  rosterCloseShortfalls: (...a: unknown[]) => closeShortfalls(...a),
}));
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { sweepAutomaticReleases } = await import('./release-sweep.js');

const QUESTION = {
  code: 'OPEN_QUESTIONS',
  reason: 'holds 1 open question',
  clears: 'Answer it, or void it with the reason it died with the work.',
};
const LANDING = {
  code: 'CLOSE_REQUIRES_SHIPPED',
  reason: 'not marked merged',
  clears: 'Mark it merged where its work landed.',
};

beforeEach(() => {
  resetSweepCursorsForTest();
  candidateRows = [{ id: 'iss-1', project_id: 'proj-1', cursor_ts: '2026-09-22T00:00:00Z' }];
  waitingIds = ['iss-1', 'iss-2', 'iss-3'];
  holds = {};
  cut.mockClear();
  closeShortfalls.mockReset();
  closeShortfalls.mockResolvedValue(new Map());
});

describe('sweepAutomaticReleases — a row its release could not close', () => {
  it('leaves it off the cut, writes its reason on it, and cuts the rows whose close stands', async () => {
    closeShortfalls.mockResolvedValue(new Map([['iss-2', [QUESTION]]]));

    const result = await sweepAutomaticReleases();

    expect(closeShortfalls).toHaveBeenCalledWith('proj-1', ['iss-1', 'iss-2', 'iss-3']);
    expect(cut).toHaveBeenCalledWith(expect.objectContaining({ issueIds: ['iss-1', 'iss-3'] }));
    expect(holds['iss-2']).toMatchObject({ code: 'RELEASE_ISSUES_UNCLOSABLE', owes: 'human' });
    expect(holds['iss-2']?.reason).toContain('holds 1 open question (`OPEN_QUESTIONS`). Answer it');
    expect(result).toMatchObject({ issuesCut: 2, issuesExcluded: 1 });
  });

  it('owes an agent the hold where nothing on it waits for a person', async () => {
    closeShortfalls.mockResolvedValue(new Map([['iss-2', [LANDING]]]));
    await sweepAutomaticReleases();
    expect(holds['iss-2']).toMatchObject({ code: 'RELEASE_ISSUES_UNCLOSABLE', owes: 'agent' });
  });

  it('cuts nothing when every waiting row is one its release could not close', async () => {
    waitingIds = ['iss-2'];
    closeShortfalls.mockResolvedValue(new Map([['iss-2', [LANDING]]]));

    const result = await sweepAutomaticReleases();

    expect(cut).not.toHaveBeenCalled();
    expect(holds['iss-2']?.code).toBe('RELEASE_ISSUES_UNCLOSABLE');
    expect(result).toMatchObject({ issuesCut: 0, issuesExcluded: 1 });
  });

  it('cuts nothing and says so on every row when the close check cannot be read', async () => {
    closeShortfalls.mockRejectedValue(new Error('questions table unreadable'));

    await sweepAutomaticReleases();

    expect(cut).not.toHaveBeenCalled();
    expect(Object.keys(holds)).toEqual(['iss-1', 'iss-2', 'iss-3']);
    expect(holds['iss-1']?.code).toBe('RELEASE_CLOSE_UNREADABLE');
    expect(holds['iss-1']?.reason).toContain('questions table unreadable');
  });

  it('does nothing for a project with no unclaimed waiting issue', async () => {
    waitingIds = [];
    await sweepAutomaticReleases();
    expect([cut.mock.calls.length, Object.keys(holds).length]).toEqual([0, 0]);
  });
});
