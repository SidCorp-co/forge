// The refusal that stops a close claiming a ship nobody wrote anything about.
//
// `closed` is "this shipped" to every downstream reader, and until this rule
// nothing asked whether a line existed. Four issues closed that way on
// 2026-08-27 alone. These tests pin the three exemptions — drop one and a
// legitimate path breaks; add a fourth and the silent close comes back.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
const txExecute = vi.fn(async () => undefined);
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txDependentsWhere = vi.fn(async () => [] as unknown[]);
const txSelectFrom = vi.fn(() => ({
  where: vi.fn(() => ({ limit: txSelectLimit })),
  innerJoin: () => ({ where: txDependentsWhere }),
}));

// cm:why the builder is thenable AND carries `.limit` because drizzle's is — the rule reads issuesMissingReleaseRecord, which awaits `.where(...)` with no limit, while the transition's other reads still chain `.limit(1)`; a mock answering only one of the two shapes reports the rule as passing on a query it never made
const selectRows = vi.fn(async () => [] as unknown[]);
const dbSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => {
      const pending = selectRows();
      return Object.assign(pending, { limit: () => pending });
    }),
  })),
}));

vi.mock('../db/client.js', () => {
  const txStub = {
    select: vi.fn(() => ({ from: txSelectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    execute: txExecute,
  };
  return {
    db: {
      select: dbSelect,
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      transaction: vi.fn(async (cb: (tx: typeof txStub) => unknown) => cb(txStub)),
    },
  };
});

vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(async () => undefined),
  setCurrentStepForOpenIssueRun: vi.fn(async () => undefined),
}));
vi.mock('./transition-reason.js', async (importActual) => {
  const actual = await importActual<typeof import('./transition-reason.js')>();
  return { ...actual, postTransitionReasonComment: vi.fn(async () => undefined) };
});
vi.mock('./transition-evidence.js', () => ({ checkTransitionEvidence: vi.fn(async () => null) }));
vi.mock('./merged-at.js', () => ({
  markMergedIfLeavingBase: vi.fn(async () => ({ stamped: false })),
  markMergedOnClose: vi.fn(async () => ({ stamped: true })),
}));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => undefined),
}));
// cm:why the two rewrites running before this rule are stubbed so `dbSelect` is a channel only the refusal reads — sharing it, a row queued for the refusal gets consumed by a project lookup instead, and the rule reads as passing on a query it never made
vi.mock('./autonomous-reopen.js', () => ({
  resolveAutonomousReopenTarget: vi.fn(async (_p: string, s: string) => s),
}));
vi.mock('./release-gate-hold.js', () => ({
  resolveAgentCloseTarget: vi.fn(async (a: { requested: string }) => ({
    status: a.requested,
    held: false,
  })),
}));

const { TransitionError, transitionIssueStatus } = await import('./apply-transition.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const AGENT = { type: 'device', id: 'dev-1', ownerId: 'owner-1' } as const;
const HUMAN = { type: 'user', id: '33333333-3333-4333-8333-333333333333' } as const;
const NOTE = { section: 'Fixed', userFacing: 'Something a user would notice.' };

const AT_WORK = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  status: 'in_progress' as const,
  reopenCount: 0,
};

function issueRow(releaseNotes: unknown) {
  selectRows.mockResolvedValueOnce([{ id: ISSUE_ID, releaseNotes }]);
}

// cm:why every select answers with the row the rule refuses, so an exemption test cannot pass by the rule simply failing to find an issue — the close has to be let through on the exemption itself
function everyRowRefusable() {
  selectRows.mockResolvedValue([{ id: ISSUE_ID, releaseNotes: null }]);
}

function queueUpdate(status: string) {
  updateReturning.mockResolvedValueOnce([
    { id: ISSUE_ID, status, reopenCount: 0, updatedAt: new Date() },
  ]);
}

async function close(actor: typeof AGENT | typeof HUMAN, options = {}) {
  return transitionIssueStatus(AT_WORK, 'closed', actor, options);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.mockReset();
  selectRows.mockResolvedValue([]);
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
});

describe('an agent close', () => {
  it('is refused when nothing has been written about what shipped', async () => {
    issueRow(null);

    await expect(close(AGENT)).rejects.toThrow(TransitionError);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('names the field that clears it, so the session can fix it in one call', async () => {
    issueRow(null);

    const err = await close(AGENT).catch((e: unknown) => e as InstanceType<typeof TransitionError>);

    expect(err).toBeInstanceOf(TransitionError);
    expect((err as InstanceType<typeof TransitionError>).code).toBe('RELEASE_RECORD_REQUIRED');
    expect((err as InstanceType<typeof TransitionError>).detail).toContain('releaseNotes');
    expect((err as InstanceType<typeof TransitionError>).detail).toContain('dropped');
  });

  // cm:guard the staged release close is `released -> closed`, and it is caught too — ISS-822 closed from there on 2026-08-11 with a note written but no changelog line, ISS-830 and ISS-810 with no note at all. A rule scoped to the drive path would leave all three possible.
  it('is refused from `released` as well, which is the staged path the release step closes on', async () => {
    issueRow(null);

    await expect(
      transitionIssueStatus({ ...AT_WORK, status: 'released' }, 'closed', AGENT),
    ).rejects.toThrow('RELEASE_RECORD_REQUIRED');
  });

  it('goes through once a note exists', async () => {
    issueRow(NOTE);
    queueUpdate('closed');

    expect((await close(AGENT)).status).toBe('closed');
  });

  // cm:guard `skip` must NOT exempt, and this is the case that proves it: `skip` is the wide flag every internal transition carries — the decompose cascade, the park rewrites, any future sweep — so exempting on it would let an unrecorded issue reach `closed` from any of them. Only `viaCloseCascade` is narrow enough to be an exemption.
  it('does NOT exempt a bare `skip`, which the orchestrator auto-skip chain also carries', async () => {
    issueRow(null);

    await expect(close(AGENT, { skip: true })).rejects.toThrow('RELEASE_RECORD_REQUIRED');
  });

  // cm:guard `Skip` is the honest answer for a change with no user-facing half, and it MUST pass — a rule that only accepts a bullet would push an internal fix towards inventing one, which is a worse record than none
  it('accepts a `Skip` note, because what is refused is silence, not a decision not to publish', async () => {
    issueRow({ section: 'Skip', userFacing: '-' });
    queueUpdate('closed');

    expect((await close(AGENT)).status).toBe('closed');
  });
});

describe('the closes this rule deliberately does not touch', () => {
  it('a human close, which makes the shipped claim deliberately and owns it', async () => {
    everyRowRefusable();
    queueUpdate('closed');

    expect((await close(HUMAN)).status).toBe('closed');
  });

  it('the release path, where a release demonstrably happened before the close', async () => {
    everyRowRefusable();
    queueUpdate('closed');

    expect((await close(AGENT, { viaReleasePath: true })).status).toBe('closed');
  });

  it('`dropped`, which closes without claiming anything shipped', async () => {
    everyRowRefusable();
    queueUpdate('dropped');

    expect((await transitionIssueStatus(AT_WORK, 'dropped', AGENT)).status).toBe('dropped');
  });

  it('a park, which is not a close at all', async () => {
    everyRowRefusable();
    queueUpdate('needs_info');

    const result = await transitionIssueStatus(AT_WORK, 'needs_info', AGENT, {
      transitionReason: 'which of the two shapes do you want',
    });

    expect(result.status).toBe('needs_info');
  });
});
