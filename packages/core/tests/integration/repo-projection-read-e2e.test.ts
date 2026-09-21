/**
 * What a device reads back once the deliveries have been applied.
 *
 * Every case here builds its rows through the same event path the write suite
 * exercises rather than by INSERT, because the reading under test is of columns
 * and jsonb the projection wrote — a hand-built row would prove the SELECT and
 * nothing about the shape it selects from.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { BASE, H1, H2, projectionGround } from './repo-projection-ground.js';

describe('the repo projection as the admissible payload reads it', () => {
  const g = projectionGround();

  it('carries every pull request linked to an issue, open before closed', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent({ number: 10 }));
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        number: 10,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-17T03:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        updated_at: '2026-09-17T03:00:00Z',
      }),
    );
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent({ number: 11 }));

    const projected = await g.mods.readPullRequestsForIssues([issueId]);
    const list = projected.get(issueId) ?? [];
    expect(list.map((p) => [p.number, p.state])).toEqual([
      [11, 'open'],
      [10, 'merged'],
    ]);
  });

  it('answers nothing for an issue with no pull request', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    const projected = await g.mods.readPullRequestsForIssues([issueId]);
    expect(projected.get(issueId)).toBeUndefined();
  });

  it('tells a green open pull request from a conflicting one', async () => {
    const green = await g.seedIssue(g.projectId, 4242);
    const conflicted = await g.seedIssue(g.projectId, 4343);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent({ number: 10 }));
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ number: 11, head: { ref: 'ISS-4343-other', sha: H2 } }),
    );

    const greenRow = (await g.harness.db.execute(sql`
        SELECT id FROM repo_pull_requests WHERE binding_id = ${g.bindingId} AND number = 10
      `)) as unknown as Array<{ id: string }>;
    const badRow = (await g.harness.db.execute(sql`
        SELECT id FROM repo_pull_requests WHERE binding_id = ${g.bindingId} AND number = 11
      `)) as unknown as Array<{ id: string }>;

    await g.mods.storeRefresh(
      String(greenRow[0]?.id),
      { headSha: H1, baseRef: 'main' },
      {
        ok: true,
        behindBy: 0,
        aheadBy: 3,
        mergeable: true,
        mergeableState: 'clean',
        baseSha: BASE,
      },
    );
    await g.mods.applyCheckRunEvent(g.ctx(), {
      check_run: {
        id: 1,
        name: 'ci-passed',
        head_sha: H1,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-09-17T01:00:00Z',
        completed_at: '2026-09-17T01:05:00Z',
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 10 }],
      },
      repository: { full_name: 'SidCorp-co/forge' },
    });
    await g.mods.storeRefresh(
      String(badRow[0]?.id),
      { headSha: H2, baseRef: 'main' },
      {
        ok: true,
        behindBy: 12,
        aheadBy: 1,
        mergeable: false,
        mergeableState: 'dirty',
        baseSha: BASE,
      },
    );

    const projected = await g.mods.readPullRequestsForIssues([green, conflicted]);
    expect(projected.get(green)?.[0]).toMatchObject({
      mergeableState: 'clean',
      behindBy: 0,
      refreshedForHead: H1,
      checks: { total: 1, success: 1, failure: 0, pending: 0 },
    });
    expect(projected.get(conflicted)?.[0]).toMatchObject({
      mergeableState: 'dirty',
      behindBy: 12,
      checks: { total: 0, success: 0, failure: 0, pending: 0 },
    });
  });

  it('leaves a dismissed review out of what it reports as open', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.applyReviewEvent(g.ctx(), {
      action: 'submitted',
      review: {
        id: 1,
        state: 'APPROVED',
        submitted_at: '2026-09-17T01:00:00Z',
        user: { login: 'a' },
      },
      pull_request: { number: 77 },
    });
    await g.mods.applyReviewEvent(g.ctx(), {
      action: 'dismissed',
      review: {
        id: 2,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-17T01:00:00Z',
        user: { login: 'b' },
      },
      pull_request: { number: 77 },
    });
    const projected = await g.mods.readPullRequestsForIssues([issueId]);
    expect(projected.get(issueId)?.[0]?.reviews).toEqual([
      { id: '1', reviewer: 'a', state: 'approved', submittedAt: '2026-09-17T01:00:00Z' },
    ]);
  });

  it('carries both reviews by one person in submission order, with what orders them', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.applyReviewEvent(g.ctx(), {
      action: 'submitted',
      review: {
        id: 2,
        state: 'APPROVED',
        submitted_at: '2026-09-17T02:00:00Z',
        user: { login: 'codex' },
      },
      pull_request: { number: 77 },
    });
    await g.mods.applyReviewEvent(g.ctx(), {
      action: 'submitted',
      review: {
        id: 1,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-17T01:00:00Z',
        user: { login: 'codex' },
      },
      pull_request: { number: 77 },
    });

    const projected = await g.mods.readPullRequestsForIssues([issueId]);
    expect(projected.get(issueId)?.[0]?.reviews).toEqual([
      {
        id: '1',
        reviewer: 'codex',
        state: 'changes_requested',
        submittedAt: '2026-09-17T01:00:00Z',
      },
      { id: '2', reviewer: 'codex', state: 'approved', submittedAt: '2026-09-17T02:00:00Z' },
    ]);
  });
});
