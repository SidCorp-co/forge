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

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: txSelectFrom })),
    update: dbUpdate,
    execute: txExecute,
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
  return { ...actual, listActiveBindingsForEnvironment: () => listBindings() };
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

const markMergedOnCloseMock = vi.fn(async (..._a: unknown[]) => ({ stamped: false }));
vi.mock('./merged-at.js', () => ({
  markMergedIfLeavingBase: vi.fn(async () => undefined),
  markMergedOnClose: (...a: unknown[]) => markMergedOnCloseMock(...a),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));

const { transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AGENT = { type: 'device', id: 'dev-1', ownerId: 'owner-1' } as const;
const HUMAN = { type: 'user', id: '33333333-3333-4333-8333-333333333333' } as const;

/** A project WITH production: a prod binding, and a production branch that is not the base. */
function gated() {
  projectSelectLimit.mockResolvedValueOnce([{ baseBranch: 'dev', productionBranch: 'master' }]);
  listBindings.mockResolvedValueOnce([{ binding: { provider: 'coolify' }, connection: {} }]);
}

/** A project with NO production — either half missing is enough. */
function ungated(over: { branches?: boolean } = {}) {
  projectSelectLimit.mockResolvedValueOnce(
    over.branches
      ? [{ baseBranch: 'dev', productionBranch: 'master' }]
      : [{ baseBranch: 'main', productionBranch: 'main' }],
  );
  listBindings.mockResolvedValueOnce(
    over.branches ? [] : [{ binding: { provider: 'sentry' }, connection: {} }],
  );
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
  // cm:edge contract -> packages/core/src/issues/release-record-required.ts — that rule reads through this same channel on every device close, so the fallback row carries a release note: without one every close here would be refused for a reason this file is not about, and with an EMPTY fallback it would pass for the equally wrong reason that the rule found no row
  projectSelectLimit.mockResolvedValue([{ id: ISSUE_ID, releaseNotes: { section: 'Skip' } }]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('an agent closing on a project that declared a release gate', () => {
  it('lands at the gate instead of `closed`', async () => {
    gated();
    queueUpdate('released');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(updateSet.mock.calls[0]?.[0]).toMatchObject({ status: 'released' });
    expect(result.status).toBe('released');
  });

  // cm:guard the merge stamp must survive the hold or the gate stops a false "shipped" by stalling every dependent instead — `merged_at` means "on the base branch", which a held issue is
  it('still stamps `merged_at`, because the branch did land', async () => {
    gated();
    queueUpdate('released');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(markMergedOnCloseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStatus: 'closed' }),
    );
    expect(result.terminal).toBe(true);
  });

  it('closes the run, because the session is over even though the issue is not', async () => {
    gated();
    queueUpdate('released');

    await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(closeRunMock).toHaveBeenCalledWith(ISSUE_ID, 'completed');
  });

  it('says on the issue that it is merged and not shipped', async () => {
    gated();
    queueUpdate('released');

    await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    const body = String(insertValues.mock.calls[0]?.[0]?.body ?? '');
    expect(body).toContain('merged, not shipped');
  });

  // cm:guard `dropped` means "this was not work" — holding it for a release it will never be part of parks it forever, and it is the one close that deliberately does not stamp
  it('lets `dropped` through the gate untouched', async () => {
    queueUpdate('dropped');

    const result = await transitionIssueStatus(AT_WORK, 'dropped', AGENT);

    expect(result.status).toBe('dropped');
    expect(dbSelect).not.toHaveBeenCalled();
  });
});

describe('who may still write `closed`', () => {
  it('a human, who is making the shipped claim deliberately', async () => {
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', HUMAN);

    expect(result.status).toBe('closed');
    expect(dbSelect).not.toHaveBeenCalled();
  });

  // cm:guard this is the flag `release_batch finish` passes; if it ever stopped working the release would rewrite its own close back to the gate and no issue would ever close again
  it('the release path itself', async () => {
    gated();
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT, {
      viaReleasePath: true,
    });

    expect(result.status).toBe('closed');
  });

  // cm:guard both halves, separately. A trunk project with a prod binding (forge-dev carries two, sentry and epodsystem) and a promoting project with none (epodsystem-core, dev->master) each fail exactly one half, and each must keep closing its own issues — a gate on either would park every issue behind a release nothing is configured to cut.
  it('an agent on a project whose production branch is its base', async () => {
    ungated();
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(result.status).toBe('closed');
  });

  it('an agent on a project with distinct branches but no production binding', async () => {
    ungated({ branches: true });
    queueUpdate('closed');

    const result = await transitionIssueStatus(AT_WORK, 'closed', AGENT);

    expect(result.status).toBe('closed');
  });
});
