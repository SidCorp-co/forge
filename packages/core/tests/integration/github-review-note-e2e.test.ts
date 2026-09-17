/**
 * One review, one record — against Postgres, because that is the only runtime where the claim can
 * fail.
 *
 * ISS-1074 criteria 18 to 22. The property under test is that two doors write once between them,
 * and it is carried by a `SELECT … FOR UPDATE` on the issue row and a `LIKE` on a marker in the
 * comment body. A stub whose `where` returned itself would make every case here pass with the lock
 * and the marker both deleted, which is the proof-by-absence this file exists to avoid — the same
 * reason `projection-refresh.test.ts` sends its fencing half here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { projectionGround } from './repo-projection-ground.js';

const ground = projectionGround();

type NoteReview = typeof import('../../src/integrations/github/review-note.js').noteReviewOnIssue;
let noteReviewOnIssue: NoteReview;

const REPO = 'SidCorp-co/forge';
const HEAD_REF = 'ISS-4242-projection';

/** The `pull_request_review` delivery, in the shape GitHub sends it. */
function reviewEvent(over: { id?: number; action?: string; state?: string; body?: string } = {}) {
  return {
    action: over.action ?? 'submitted',
    review: {
      id: over.id ?? 2847100311,
      state: over.state ?? 'changes_requested',
      submitted_at: '2026-09-17T10:39:38Z',
      html_url: `https://github.com/${REPO}/pull/77#pullrequestreview-${over.id ?? 2847100311}`,
      user: { login: 'junixlabs' },
      body: over.body ?? 'The projection half is right.',
    },
    pull_request: { number: 77, head: { ref: HEAD_REF } },
    repository: { full_name: REPO },
  };
}

function deliveryCtx() {
  return {
    projectId: ground.projectId,
    bindingId: ground.bindingId,
    config: { owner: 'SidCorp-co', repo: 'forge' },
    secrets: {},
  };
}

async function commentsOn(issueId: string): Promise<Array<{ body: string; author_id: string }>> {
  return (await ground.harness.db.execute(sql`
    SELECT body, author_id FROM comments WHERE issue_id = ${issueId} ORDER BY created_at
  `)) as unknown as Array<{ body: string; author_id: string }>;
}

beforeAll(async () => {
  noteReviewOnIssue = (await import('../../src/integrations/github/review-note.js'))
    .noteReviewOnIssue;
});

describe("a human's GitHub review flows back onto the issue", () => {
  // ISS-1074 criteria 18 and 21 in one case, and the second half is the load-bearing one: NO
  // `pull_request` delivery has ever arrived, so there is no projection row to hang a key on and
  // `applyReviewEvent` writes nothing. The comment is written anyway.
  it('writes one comment with no projection row in existence', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);

    const moved = await ground.mods.applyProjectedEvent(
      deliveryCtx(),
      'pull_request_review',
      reviewEvent(),
    );

    expect(await ground.row(77)).toBeUndefined();
    expect(moved).toBe(1);
    const rows = await commentsOn(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain('**junixlabs** requested changes on');
    expect(rows[0]?.body).toContain('> The projection half is right.');
    expect(rows[0]?.body).toContain('[github-review:2847100311]');
  });

  it('writes the comment and the projection row when the pull request is already held', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request', ground.prEvent());

    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());

    const row = await ground.row(77);
    expect(Object.keys((row?.reviews ?? {}) as object)).toEqual(['2847100311']);
    expect(await commentsOn(issueId)).toHaveLength(1);
  });

  // ISS-1074 criterion 20 — redelivery. GitHub retries, and a retry is the ordinary shape.
  it('writes one comment for the same review delivered twice', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());
    expect(await commentsOn(issueId)).toHaveLength(1);
  });

  it('writes a second comment for a DIFFERENT review, so the key is the review and not the issue', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());
    await ground.mods.applyProjectedEvent(
      deliveryCtx(),
      'pull_request_review',
      reviewEvent({ id: 2847100999, state: 'approved', body: 'now it is right' }),
    );
    const rows = await commentsOn(issueId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.body).toContain('**junixlabs** approved');
  });

  // ISS-1074 criterion 22 — an ordinary answer and never an error. A dependabot bump's branch names
  // no issue, and the review on it is still a review this repository had.
  it('writes nothing and raises nothing for a branch that names no issue', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    const event = reviewEvent();
    event.pull_request.head.ref = 'dependabot/npm_and_yarn/minor-and-patch';

    await expect(
      ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', event),
    ).resolves.toBe(0);
    expect(await commentsOn(issueId)).toHaveLength(0);
  });

  it('writes nothing for a branch naming an issue that belongs to another project', async () => {
    const mine = await ground.seedIssue(ground.projectId, 4242);
    await ground.seedIssue(ground.otherProjectId, 9999);
    const event = reviewEvent();
    event.pull_request.head.ref = 'ISS-9999-somebody-elses';

    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', event);
    expect(await commentsOn(mine)).toHaveLength(0);
  });

  // cm:guard a dismissal is a retraction of a review already recorded, not a second event to record. Writing one would be the second record this whole write-back exists to remove.
  it('writes no comment for a dismissal', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(
      deliveryCtx(),
      'pull_request_review',
      reviewEvent({ action: 'dismissed' }),
    );
    expect(await commentsOn(issueId)).toHaveLength(0);
  });
});

describe('the two doors are one writer', () => {
  // ISS-1074 criteria 19 and 20. The tool's own call lands first — as it does when an agent submits
  // through `forge_github` — and the App's webhook echo arrives after. Exactly one comment survives
  // both, which is what makes the write-back safe whether or not GitHub echoes an App's own write.
  it('writes once when the tool writes first and the webhook echoes after', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);

    const first = await noteReviewOnIssue({
      projectId: ground.projectId,
      headRef: HEAD_REF,
      repository: REPO,
      number: 77,
      review: {
        id: '2847100311',
        reviewer: 'forge[bot]',
        state: 'approved',
        submittedAt: '2026-09-17T10:39:38Z',
        url: null,
        body: 'ship it',
      },
    });
    expect(first.outcome).toBe('written');

    const second = await ground.mods.applyProjectedEvent(
      deliveryCtx(),
      'pull_request_review',
      reviewEvent(),
    );
    expect(second).toBe(0);
    expect(await commentsOn(issueId)).toHaveLength(1);
  });

  it('writes once when the webhook arrives first and the tool follows', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());

    const late = await noteReviewOnIssue({
      projectId: ground.projectId,
      headRef: HEAD_REF,
      repository: REPO,
      number: 77,
      review: {
        id: '2847100311',
        reviewer: 'forge[bot]',
        state: 'approved',
        submittedAt: null,
        url: null,
        body: 'ship it',
      },
    });
    expect(late.outcome).toBe('already-noted');
    expect(await commentsOn(issueId)).toHaveLength(1);
  });

  // The race is the case the issue-row lock exists for: a check-then-insert without it lets every
  // caller find nothing and every one of them write.
  //
  // cm:guard EIGHT and not three. Measured 2026-09-17 with `FOR UPDATE` deleted: three callers still produced one comment — the pre-transaction reads keep them in lockstep and the first insert commits before the second's check — and eight produced SEVEN. A count that cannot represent the failure is a green that means nothing, so the number is the evidence and not a taste.
  it('writes once when eight callers run at the same moment', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    const one = () =>
      noteReviewOnIssue({
        projectId: ground.projectId,
        headRef: HEAD_REF,
        repository: REPO,
        number: 77,
        review: {
          id: '2847100311',
          reviewer: 'junixlabs',
          state: 'approved',
          submittedAt: null,
          url: null,
          body: 'concurrent',
        },
      });

    const outcomes = (await Promise.all(Array.from({ length: 8 }, () => one()))).map(
      (r) => r.outcome,
    );
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(await commentsOn(issueId)).toHaveLength(1);
  });

  it('attributes the comment to the project s creator, as the webhook door already does', async () => {
    const issueId = await ground.seedIssue(ground.projectId, 4242);
    await ground.mods.applyProjectedEvent(deliveryCtx(), 'pull_request_review', reviewEvent());
    const rows = await commentsOn(issueId);
    expect(rows[0]?.author_id).toBe(ground.ownerId);
  });

  it('refuses a review id that is not a number, before it reaches the duplicate check', async () => {
    await ground.seedIssue(ground.projectId, 4242);
    await expect(
      noteReviewOnIssue({
        projectId: ground.projectId,
        headRef: HEAD_REF,
        repository: REPO,
        number: 77,
        review: {
          id: `${randomUUID()}%`,
          reviewer: 'x',
          state: 'approved',
          submittedAt: null,
          url: null,
          body: null,
        },
      }),
    ).rejects.toThrow(/is not a number/);
  });
});
