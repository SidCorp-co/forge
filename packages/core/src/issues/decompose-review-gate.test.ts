// ISS-886 — the review gate is the only `waiting` core still writes itself, and
// on an autonomous project it is the only one that survives: every other
// device-actor `waiting` is rewritten to `needs_info` by `autonomous-park.ts`.
// Both of the guards on the module under test describe a failure that is SILENT
// — the transition throws, the catch turns it into a warn log, and the parent
// is left un-parked with its children already committed — so nothing downstream
// would report either one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const applyStatusTransitionMock = vi.fn(async (..._a: unknown[]) => ({}) as unknown);
vi.mock('./apply-transition.js', () => ({
  applyStatusTransition: (...a: unknown[]) => applyStatusTransitionMock(...a),
}));

const warnMock = vi.fn();
vi.mock('../logger.js', () => ({ logger: { warn: (...a: unknown[]) => warnMock(...a) } }));

const selectLimit = vi.fn(async () => [] as unknown[]);
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({ db: { select: vi.fn(() => ({ from: selectFrom })) } }));

const { parkParentAtReviewGate, reviewGateReason } = await import('./decompose-review-gate.js');

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';

const BASE = {
  parentId: PARENT_ID,
  projectId: PROJECT_ID,
  fromStatus: 'in_progress' as const,
  createdEdges: 3,
  skip: false,
  autonomous: true,
};

function projectExists() {
  selectLimit.mockResolvedValueOnce([{ createdBy: OWNER_ID }]);
}

function optsOfLastCall(): Record<string, unknown> {
  return (applyStatusTransitionMock.mock.calls.at(-1)?.[3] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectLimit.mockResolvedValue([]);
  applyStatusTransitionMock.mockReset();
  applyStatusTransitionMock.mockResolvedValue({});
});

describe('parkParentAtReviewGate', () => {
  it('parks the parent at `waiting`, not at the rewritten autonomous park', async () => {
    projectExists();

    await parkParentAtReviewGate(BASE);

    expect(applyStatusTransitionMock).toHaveBeenCalledTimes(1);
    expect(applyStatusTransitionMock.mock.calls[0]?.[1]).toBe('waiting');
  });

  it('sets `viaDecomposeGate`, the one thing that keeps this park representable on autonomous', async () => {
    projectExists();

    await parkParentAtReviewGate(BASE);

    expect(optsOfLastCall().viaDecomposeGate).toBe(true);
  });

  it('carries BOTH the kind and an authored reason, which the transition demands of core too', async () => {
    projectExists();

    await parkParentAtReviewGate(BASE);

    const opts = optsOfLastCall();
    expect(opts.waitingKind).toBe('needs_decision');
    expect(opts.transitionReason).toBe(reviewGateReason(3, true));
    expect(String(opts.transitionReason).length).toBeGreaterThan(0);
  });

  it('parks from whatever status the parent actually held, per mode', async () => {
    projectExists();

    await parkParentAtReviewGate({ ...BASE, fromStatus: 'clarified', autonomous: false });

    expect(applyStatusTransitionMock.mock.calls[0]?.[0]).toMatchObject({
      id: PARENT_ID,
      projectId: PROJECT_ID,
      status: 'clarified',
    });
  });

  it('writes nothing on a re-split, when the parent is already at the gate', async () => {
    projectExists();

    await parkParentAtReviewGate({ ...BASE, skip: true });

    expect(applyStatusTransitionMock).not.toHaveBeenCalled();
  });

  it('writes nothing when no edge was created', async () => {
    projectExists();

    await parkParentAtReviewGate({ ...BASE, createdEdges: 0 });

    expect(applyStatusTransitionMock).not.toHaveBeenCalled();
  });

  it('writes nothing when the project has no creator to attribute the park to', async () => {
    selectLimit.mockResolvedValueOnce([]);

    await parkParentAtReviewGate(BASE);

    expect(applyStatusTransitionMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('swallows a failed park into a warn rather than unwinding children already committed', async () => {
    projectExists();
    applyStatusTransitionMock.mockRejectedValueOnce(new Error('WAITING_KIND_REQUIRED'));

    await expect(parkParentAtReviewGate(BASE)).resolves.toBeUndefined();

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toMatchObject({ parentId: PARENT_ID });
  });
});

describe('reviewGateReason', () => {
  it('names `open` on an autonomous project — the board has no `approved` to offer', () => {
    const text = reviewGateReason(4, true);

    expect(text).toContain('`open`');
    expect(text).not.toContain('`approved`');
    expect(text).toContain('4 child issues');
  });

  it('names `approved` on a staged project, unchanged', () => {
    const text = reviewGateReason(4, false);

    expect(text).toContain('`approved`');
    expect(text).not.toContain('`open`');
  });

  it('singularises a one-child split', () => {
    expect(reviewGateReason(1, true)).toContain('1 child issue.');
    expect(reviewGateReason(2, true)).toContain('2 child issues');
  });
});
