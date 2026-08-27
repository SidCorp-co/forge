import { beforeEach, describe, expect, it, vi } from 'vitest';

const postTransitionReasonComment = vi.fn(async () => undefined);
const withActorContext = vi.fn(async (tx, _actor, _reason, callback) => callback(tx));
const updatedAt = new Date('2026-08-27T00:00:00.000Z');
const returning = vi.fn(async () => [{ updatedAt }]);
const where = vi.fn(() => ({ returning }));
const set = vi.fn(() => ({ where }));
const update = vi.fn(() => ({ set }));
const tx = { update };

vi.mock('./transition-reason.js', () => ({ postTransitionReasonComment }));
vi.mock('../pipeline/outbox-session.js', () => ({ withActorContext }));
vi.mock('./apply-transition.js', () => ({ publishIssueStatusChange: vi.fn() }));
vi.mock('./pipeline-health.js', () => ({ publishPipelineHealthChanged: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({ setCurrentStepForOpenIssueRun: vi.fn() }));

const { parkDecomposedParent } = await import('./decompose-review-gate.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  returning.mockResolvedValue([{ updatedAt }]);
});

describe('parkDecomposedParent', () => {
  it('uses child ids rather than inserted-edge count in the review-gate reason', async () => {
    const reviewGate = await parkDecomposedParent(
      tx as never,
      {
        parentAlreadyDecomposed: false,
        parentId: PARENT_ID,
        parentStatus: 'confirmed',
        projectId: PROJECT_ID,
        hasActiveDecomposition: true,
        childIds: [CHILD_ID],
      },
      { type: 'user', id: ACTOR_ID },
    );

    expect(reviewGate).toEqual({ actorId: ACTOR_ID, fromStatus: 'confirmed', updatedAt });
    expect(postTransitionReasonComment).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('Decomposed into 1 child issue.'),
      }),
      tx,
    );
  });
});
