import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn(async () => undefined);
const dbInsert = vi.fn(() => ({ values: insertValues }));
vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  buildBounceReplayCommentBody,
  buildMissingPlanCommentBody,
  buildNeedsInfoFixCommentBody,
  postBounceReplayComment,
  postMissingPlanComment,
  postNeedsInfoReopenComment,
} = await import('./plan-gate-guard.js');

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

describe('buildNeedsInfoFixCommentBody', () => {
  it('explains a fix cannot be scoped from an unanswered question', () => {
    expect(buildNeedsInfoFixCommentBody()).toContain('unanswered question');
  });
});

describe('postMissingPlanComment / postNeedsInfoReopenComment', () => {
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

  it('posts the needs_info-reopen comment', async () => {
    await postNeedsInfoReopenComment({ issueId: 'iss-1', authorId: 'owner-1' });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'iss-1', authorId: 'owner-1', isAi: true }),
    );
  });

  // cm:guard dispatch-gate skips are otherwise silent — losing the comment must never fail the guard's routing decision
  it('swallows a failed comment insert', async () => {
    insertValues.mockRejectedValueOnce(new Error('db down'));
    await expect(
      postMissingPlanComment({ issueId: 'iss-1', authorId: 'owner-1', routedTo: 'needs_info' }),
    ).resolves.toBeUndefined();
  });
});

describe('buildBounceReplayCommentBody', () => {
  it('tells a needs_info bounce to answer in a COMMENT — a field edit does not release it', () => {
    const body = buildBounceReplayCommentBody({ bounced: 'needs_info' });
    expect(body).toContain('`needs_info`');
    expect(body).toContain('answer in a comment');
    expect(body).toContain('field edit does not release');
  });

  it('asks for the decision as a comment on a park', () => {
    const body = buildBounceReplayCommentBody({ bounced: 'waiting' });
    expect(body).toContain('`waiting`');
    expect(body).toContain('comment');
  });
});

describe('postBounceReplayComment', () => {
  // cm:why isAi:true is what stops this refusal reading as the human answer the guard waits for
  it('writes an isAi comment, and no-ops without a resolvable author', async () => {
    await postBounceReplayComment({ issueId: 'i1', authorId: 'u1', bounced: 'needs_info' });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'i1', isAi: true }),
    );

    insertValues.mockClear();
    await postBounceReplayComment({ issueId: 'i1', authorId: null, bounced: 'needs_info' });
    expect(insertValues).not.toHaveBeenCalled();
  });
});
