// The gate that stops an autonomous agent claiming a release it never made.
// epodsystem ISS-141 self-closed on 2026-08-24 with the reported bug still
// live; these tests pin who may write `closed` and what a held close still
// does — the merge stamp and the dependent fan-out both have to survive it,
// or the gate trades a false "shipped" for a stalled dependency graph.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));
const txExecute = vi.fn(async () => undefined);
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
const txDependentsWhere = vi.fn(async () => [] as unknown[]);
const txSelectFrom = vi.fn(() => ({
  where: txSelectWhere,
  innerJoin: () => ({ where: txDependentsWhere }),
}));

const projectSelectLimit = vi.fn(async () => [] as unknown[]);
const projectSelectWhere = vi.fn(() => ({ limit: projectSelectLimit }));
const projectSelectFrom = vi.fn(() => ({ where: projectSelectWhere }));
const dbSelect = vi.fn(() => ({ from: projectSelectFrom }));
const insertValues = vi.fn(async (_v: Record<string, unknown>) => undefined);

// The archived-issue guard reads the row itself; these tests script every select, so it answers none.
vi.mock('./archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./archive.js')>()),
  archivedAmong: vi.fn(async () => []),
  archiveRefusalForTransition: vi.fn(async () => null),
}));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: txSelectFrom })),
    update: dbUpdate,
    execute: txExecute,
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  return {
    db: {
      select: dbSelect,
      insert: vi.fn(() => ({ values: insertValues })),
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));

const listBindings = vi.fn(async () => [] as unknown[]);
vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const closeRunMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: (...a: unknown[]) => closeRunMock(...a),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));

vi.mock('./transition-reason.js', async (importActual) => {
  const actual = await importActual<typeof import('./transition-reason.js')>();
  return { ...actual, postTransitionReasonComment: vi.fn(async () => undefined) };
});
vi.mock('./transition-evidence.js', () => ({ checkTransitionEvidence: vi.fn(async () => null) }));

const refuseUnshippedCloseMock = vi.fn(async (..._a: unknown[]) => null);
vi.mock('./merged-at.js', () => ({
  BASE_MERGE_STATE: 'awaiting_release',
  refuseUnshippedClose: (...a: unknown[]) => refuseUnshippedCloseMock(...a),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AGENT = { type: 'device', id: 'dev-1', ownerId: 'owner-1' } as const;
const HUMAN = { type: 'user', id: '33333333-3333-4333-8333-333333333333' } as const;

/** A project that DECLARES a release and has somewhere for it to land. */
function gated() {
  projectSelectLimit.mockResolvedValueOnce([
    {
      baseBranch: 'dev',
      liveBranch: 'master',
      releaseModel: 'promote',
      releaseStrategy: 'merge-branch',
    },
  ]);
  listBindings.mockResolvedValueOnce([{ binding: { provider: 'coolify' }, connection: {} }]);
}

/**
 * A project that declares it ships nowhere. Since ISS-1046 this is the ONLY ungated shape:
 * the gate reads `releaseModel` and does not infer from branch names or provider identity, so
 * a trunk project and a storefront are ungated for the same declared reason or not at all.
 */
function ungated() {
  projectSelectLimit.mockResolvedValueOnce([
    { baseBranch: 'main', liveBranch: null, releaseModel: 'none', releaseStrategy: null },
  ]);
}

/** A project that declares a release but has no live deploy binding to land it on. */
function undeclaredTarget() {
  projectSelectLimit.mockResolvedValueOnce([
    {
      baseBranch: 'dev',
      liveBranch: 'master',
      releaseModel: 'promote',
      releaseStrategy: 'merge-branch',
    },
  ]);
  listBindings.mockResolvedValueOnce([]);
}

function queueUpdate(status: string) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount: 0, updatedAt: new Date() },
  ]);
}

const AT_WORK = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  status: 'in_progress' as const,
  reopenCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  projectSelectLimit.mockReset();
  listBindings.mockReset();
  listBindings.mockResolvedValue([]);
  projectSelectLimit.mockResolvedValue([{ id: ISSUE_ID, releaseNotes: { section: 'Skip' } }]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('an agent closing on a project that declared a release gate', () => {
  it('lands at the gate instead of `closed`', async () => {
    gated();
    queueUpdate('awaiting_release');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'awaiting_release' });
    expect(result.status).toBe('awaiting_release');
  });

  it('is judged on where it lands, so the shipped-work rule never fires (ISS-1108)', async () => {
    gated();
    queueUpdate('awaiting_release');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(refuseUnshippedCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'awaiting_release' }),
    );
    expect(result.terminal).toBe(true);
  });

  it('closes the run, because the session is over even though the issue is not', async () => {
    gated();
    queueUpdate('awaiting_release');

    await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(closeRunMock).toHaveBeenCalledWith(ISSUE_ID, 'completed');
  });

  it('says on the issue that it is merged and not shipped', async () => {
    gated();
    queueUpdate('awaiting_release');

    await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    const body = String(insertValues.mock.calls[0]?.[0]?.body ?? '');
    expect(body).toContain('merged, not shipped');
  });

  it('lets `dropped` through the gate untouched', async () => {
    queueUpdate('dropped');

    const result = await transitionIssueStatus(AT_WORK, 'dropped', AGENT);

    expect(result.status).toBe('dropped');
    expect(listBindings).not.toHaveBeenCalled();
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});

describe('who may still write `closed`', () => {
  it('a human, who is making the shipped claim deliberately', async () => {
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', HUMAN);

    expect(result.status).toBe('closed');
    expect(listBindings).not.toHaveBeenCalled();
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });

  it('the release path itself', async () => {
    gated();
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT, {
      viaReleasePath: true,
    });

    expect(result.status).toBe('closed');
  });

  it('an agent on a project that declares `releaseModel: none`', async () => {
    ungated();
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(result.status).toBe('closed');
    // `none` short-circuits before the binding query: nothing about the bindings
    // can make a declared non-releasing project release.
    expect(listBindings).not.toHaveBeenCalled();
  });

  /**
   * ISS-1108 — a close stamps no `merged_at`, so it has nothing to tell the reader
   * to withdraw and posts no audit comment at all. A close that lands is silent.
   */
  it('and a close that lands writes no audit comment at all', async () => {
    ungated();
    queueUpdate('closed');

    await transitionIssueStatus(AT_WORK, 'closed', HUMAN);

    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe('a project that declares a release it cannot land', () => {
  it('refuses the close by name instead of letting it through', async () => {
    undeclaredTarget();
    queueUpdate('closed');

    await expect(transitionIssueStatus(AT_WORK, 'closed', AGENT)).rejects.toThrow(
      /RELEASE_TARGET_UNDECLARED/,
    );
  });

  it('names the project and the two ways out', async () => {
    undeclaredTarget();
    queueUpdate('closed');

    const err = await transitionIssueStatus(AT_WORK, 'closed', AGENT).catch((e: Error) => e);

    expect(String(err)).toContain(PROJECT_ID);
    expect(String(err)).toContain("no active deploy binding carrying the 'live' stage");
    expect(String(err)).toContain("releaseModel='none'");
  });
});
