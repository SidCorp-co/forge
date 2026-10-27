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
vi.mock('../questions/issue-coupling.js', () => ({ settleOpenQuestions: async () => null }));
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
// The release-tag rule reads the project's repository, so these cases script what it answers.
const releaseTagOfMock = vi.fn(async (..._a: unknown[]) => null as string | null);
const holdReleaseTagCloseMock = vi.fn(
  async (_i: unknown, _s: unknown, options: unknown) => options,
);
vi.mock('./release-tag-close.js', () => ({
  releaseTagOf: (...a: unknown[]) => releaseTagOfMock(...a),
  holdReleaseTagClose: (...a: [unknown, unknown, unknown]) => holdReleaseTagCloseMock(...a),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { TransitionError, transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AGENT = { type: 'device', id: 'dev-1', ownerId: 'owner-1' } as const;
const HUMAN = { type: 'user', id: '33333333-3333-4333-8333-333333333333' } as const;

/** A project that DECLARES a release and has somewhere for it to land. */
function gated() {
  projectSelectLimit.mockResolvedValueOnce([
    {
      baseBranch: 'dev',
      releaseChain: [{ branch: 'dev' }, { branch: 'master', from: 'merge-branch' }],
    },
  ]);
  listBindings.mockResolvedValueOnce([{ binding: { provider: 'coolify' }, connection: {} }]);
}

/**
 * A project that declares it ships nowhere. Since ISS-1046 this is the ONLY ungated shape:
 * the gate reads `releaseChain` and does not infer from branch names or provider identity, so
 * a trunk project and a storefront are ungated for the same declared reason or not at all.
 */
function ungated() {
  projectSelectLimit.mockResolvedValueOnce([{ baseBranch: 'main', releaseChain: [] }]);
}

/** A project that declares a release but has no live deploy binding to land it on. */
function undeclaredTarget() {
  projectSelectLimit.mockResolvedValueOnce([
    {
      baseBranch: 'dev',
      releaseChain: [{ branch: 'dev' }, { branch: 'master', from: 'merge-branch' }],
      name: 'Storefront',
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
  releaseTagOfMock.mockReset();
  releaseTagOfMock.mockResolvedValue(null);
  holdReleaseTagCloseMock.mockReset();
  holdReleaseTagCloseMock.mockImplementation(async (_i, _s, options) => options);
});

describe('an agent closing on a project that declared a release gate', () => {
  it('lands at the gate instead of `closed`', async () => {
    gated();
    queueUpdate('awaiting_release');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'awaiting_release' });
    expect(result.status).toBe('awaiting_release');
  });

  it('answers what the gate stored beside the close it was asked for (ISS-1365)', async () => {
    gated();
    queueUpdate('awaiting_release');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(result.rewritten).toMatchObject({
      requested: 'closed',
      stored: 'awaiting_release',
      rule: 'release_gate',
      waitingKind: { sent: null, stored: null },
    });
    expect(result.rewritten?.detail).toContain('release gate');
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

    expect(closeRunMock).toHaveBeenCalledWith(ISSUE_ID, 'completed', undefined);
  });

  it('says on the issue that it is merged and not shipped', async () => {
    gated();
    queueUpdate('awaiting_release');

    await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    const body = String(insertValues.mock.calls[0]?.[0]?.body ?? '');
    expect(body).toContain('merged, not released');
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
    expect(result.rewritten).toBeNull();
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

  it('an agent on a project whose release chain is empty', async () => {
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
  it('refuses the close with the typed transition refusal every door maps, never a bare error', async () => {
    undeclaredTarget();
    queueUpdate('closed');

    const err = await transitionIssueStatus(AT_WORK, 'closed', AGENT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransitionError);
    expect(err).toMatchObject({
      code: 'RELEASE_TARGET_UNDECLARED',
      details: {
        projectId: PROJECT_ID,
        releaseChain: [{ branch: 'dev' }, { branch: 'master', from: 'merge-branch' }],
      },
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('names the project and the two ways out', async () => {
    undeclaredTarget();
    queueUpdate('closed');

    const err = await transitionIssueStatus(AT_WORK, 'closed', AGENT).catch((e: Error) => e);

    expect(String(err)).toContain(`Project "Storefront" releases to 'master'`);
    expect(String(err)).not.toContain(PROJECT_ID);
    expect(String(err)).toContain('has no live deploy target, so a release has nowhere to land.');
    expect(String(err)).toContain(
      'choose "Repository, no release" under Shape & release in its settings',
    );
    expect((err as Error).message.match(/RELEASE_TARGET_UNDECLARED/g)).toHaveLength(1);
  });

  it('still lets a human make the claim, and the release path through', async () => {
    queueUpdate('closed');
    expect((await transitionIssueStatus(AT_WORK, 'closed', HUMAN)).status).toBe('closed');

    undeclaredTarget();
    queueUpdate('closed');
    const viaRelease = await transitionIssueStatus(AT_WORK, 'closed', AGENT, {
      viaReleasePath: true,
    });
    expect(viaRelease.status).toBe('closed');
  });
});

describe('a project that ships by version tag (ISS-1391)', () => {
  const refuse = () =>
    holdReleaseTagCloseMock.mockRejectedValue(
      new TransitionError(
        'CLOSE_REQUIRES_RELEASE_TAG',
        'a tag matching `v*` must contain the landing',
        {
          requires: 'releaseTag',
        },
      ),
    );

  it('does not hold an agent close at the gate, and does not ask the gate for a live binding', async () => {
    releaseTagOfMock.mockResolvedValue('v*');
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(result.status).toBe('closed');
    expect(result.rewritten).toBeNull();
    expect(listBindings).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('refuses a close the tag rule refuses, by its own code, before anything is written', async () => {
    releaseTagOfMock.mockResolvedValue('v*');
    refuse();

    const err = await transitionIssueStatus(AT_WORK, 'closed', AGENT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransitionError);
    expect(err).toMatchObject({
      code: 'CLOSE_REQUIRES_RELEASE_TAG',
      details: { requires: 'releaseTag' },
    });
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('refuses a human close and the release finish alike, which the gate would have let through', async () => {
    refuse();

    await expect(transitionIssueStatus(AT_WORK, 'closed', HUMAN)).rejects.toMatchObject({
      code: 'CLOSE_REQUIRES_RELEASE_TAG',
    });
    await expect(
      transitionIssueStatus(AT_WORK, 'closed', AGENT, { viaReleasePath: true }),
    ).rejects.toMatchObject({ code: 'CLOSE_REQUIRES_RELEASE_TAG' });
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('refuses from awaiting_release as it does from testing', async () => {
    refuse();
    for (const status of ['testing', 'awaiting_release'] as const) {
      await expect(
        transitionIssueStatus({ ...AT_WORK, status }, 'closed', HUMAN),
      ).rejects.toMatchObject({ code: 'CLOSE_REQUIRES_RELEASE_TAG' });
    }
  });

  it('asks the rule about the status the issue would land at, and runs the hook it hands back inside the write', async () => {
    const inTransaction = vi.fn(async () => undefined);
    holdReleaseTagCloseMock.mockImplementation(async (_i, _s, options) => ({
      ...(options as object),
      beforeStatusWrite: inTransaction,
    }));
    queueUpdate('dropped');

    await transitionIssueStatus(AT_WORK, 'dropped', AGENT);

    expect(holdReleaseTagCloseMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: ISSUE_ID, projectId: PROJECT_ID }),
      'dropped',
      expect.anything(),
    );
    expect(inTransaction).toHaveBeenCalledTimes(1);
  });
});
