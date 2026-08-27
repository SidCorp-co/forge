import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({ values: insertValues }));
vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildMissingPlanCommentBody, postMissingPlanComment } = await import(
  './plan-gate-guard.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMissingPlanCommentBody', () => {
  it('names clarified when routed back to write a plan', () => {
    expect(buildMissingPlanCommentBody({ routedTo: 'clarified' })).toContain('`clarified`');
  });

  it('explains the loop-avoidance when routed to needs_info', () => {
    const body = buildMissingPlanCommentBody({ routedTo: 'needs_info' });
    expect(body).toContain('`needs_info`');
    expect(body).toContain('already ran');
  });
});

describe('postMissingPlanComment', () => {
  it('posts an AI-authored comment when an authorId is resolvable', async () => {
    await postMissingPlanComment({ issueId: 'iss-1', authorId: 'owner-1', routedTo: 'clarified' });
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'iss-1', authorId: 'owner-1', isAi: true }),
    );
  });

  it('is a no-op when authorId is null', async () => {
    await postMissingPlanComment({ issueId: 'iss-1', authorId: null, routedTo: 'clarified' });
    expect(dbInsert).not.toHaveBeenCalled();
  });

  // cm:guard dispatch-gate skips are otherwise silent — losing the comment must never fail the guard's routing decision
  it('swallows a failed comment insert', async () => {
    insertValues.mockRejectedValueOnce(new Error('db down'));
    await expect(
      postMissingPlanComment({ issueId: 'iss-1', authorId: 'owner-1', routedTo: 'needs_info' }),
    ).resolves.toBeUndefined();
  });
});
