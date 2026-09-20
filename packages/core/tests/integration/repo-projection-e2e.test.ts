/**
 * The projection against real Postgres, delivery by delivery.
 *
 * Everything here is a property of a statement rather than of a function: an
 * `ON CONFLICT` whose `WHERE` decides whether an older payload rewinds a head,
 * a `CASE` that clears what described a head the row has left, an `UPDATE`
 * fenced on the head its read answered for, and a project-scoped issue lookup.
 * A stub query builder returns itself from `where` and makes every one of those
 * pass with the predicate deleted, which is why they are here and not in a unit
 * file.
 *
 * What the stored rows then read as is `repo-projection-read-e2e.test.ts`, and
 * the reads a delivery makes are `repo-projection-refresh-e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BASE, H1, H2, projectionGround } from './repo-projection-ground.js';

const g = projectionGround();

describe('a pull_request delivery', () => {
  it('stores the head, the base, the state and the link to the branch`s issue', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    expect(await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent())).toBe(1);
    const r = await g.row();
    expect(r).toMatchObject({
      issue_id: issueId,
      number: 77,
      state: 'open',
      head_ref: 'ISS-4242-projection',
      head_sha: H1,
      base_ref: 'main',
      base_sha: BASE,
      repo_full_name: 'SidCorp-co/forge',
    });
  });

  it('moves the head on a synchronize', async () => {
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        head: { ref: 'ISS-4242-projection', sha: H2 },
        updated_at: '2026-09-17T02:00:00Z',
      }),
    );
    expect((await g.row())?.head_sha).toBe(H2);
  });

  it('stores merged apart from closed, with the commit GitHub named', async () => {
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        state: 'closed',
        merged: true,
        merged_at: '2026-09-17T03:00:00Z',
        merge_commit_sha: 'd'.repeat(40),
        updated_at: '2026-09-17T03:00:00Z',
      }),
    );
    const r = await g.row();
    expect(r?.state).toBe('merged');
    expect(r?.merge_commit_sha).toBe('d'.repeat(40));
  });

  it('stores a close that is not a merge as closed with no merge commit', async () => {
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ state: 'closed', merged: false, updated_at: '2026-09-17T03:00:00Z' }),
    );
    const r = await g.row();
    expect(r?.state).toBe('closed');
    expect(r?.merge_commit_sha).toBeNull();
  });

  it('leaves every scalar alone when an older payload arrives after a newer one', async () => {
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        head: { ref: 'ISS-4242-projection', sha: H2 },
        updated_at: '2026-09-17T02:00:00Z',
      }),
    );
    const written = await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ title: 'stale title', updated_at: '2026-09-17T01:00:00Z' }),
    );
    expect(written).toBe(0);
    const r = await g.row();
    expect(r?.head_sha).toBe(H2);
    expect(r?.title).toBe('a change under review');
  });

  it('clears what described the previous head in the statement that moves the head', async () => {
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.storeRefresh(
      String((await g.row())?.id),
      { headSha: H1, baseRef: 'main' },
      {
        ok: true,
        behindBy: 9,
        aheadBy: 2,
        mergeable: false,
        mergeableState: 'dirty',
        baseSha: BASE,
      },
    );
    expect(await g.row()).toMatchObject({ behind_by: 9, mergeable_state: 'dirty' });

    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        head: { ref: 'ISS-4242-projection', sha: H2 },
        updated_at: '2026-09-17T02:00:00Z',
      }),
    );
    const r = await g.row();
    expect(r?.behind_by).toBeNull();
    expect(r?.ahead_by).toBeNull();
    expect(r?.mergeable_state).toBeNull();
    expect(r?.refreshed_for_head).toBeNull();
  });

  it('keeps a refresh that describes the head the payload also carries', async () => {
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    await g.mods.storeRefresh(
      String((await g.row())?.id),
      { headSha: H1, baseRef: 'main' },
      {
        ok: true,
        behindBy: 4,
        aheadBy: 1,
        mergeable: true,
        mergeableState: 'clean',
        baseSha: BASE,
      },
    );
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ title: 'renamed', updated_at: '2026-09-17T02:00:00Z' }),
    );
    const r = await g.row();
    expect(r?.title).toBe('renamed');
    expect(r?.behind_by).toBe(4);
  });

  it('links no issue where the branch names one belonging to another project', async () => {
    await g.seedIssue(g.otherProjectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    expect((await g.row())?.issue_id).toBeNull();
  });

  it('links no issue where the branch names none', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ head: { ref: 'dependabot/npm_and_yarn/vite-5', sha: H1 } }),
    );
    expect((await g.row())?.issue_id).toBeNull();
  });
});

describe('a check_run delivery', () => {
  async function open() {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
  }

  function checkEvent(over: Record<string, unknown> = {}) {
    return {
      check_run: {
        id: 900,
        name: 'ci-passed',
        head_sha: H1,
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://github.com/x',
        started_at: '2026-09-17T01:10:00Z',
        completed_at: '2026-09-17T01:20:00Z',
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 77 }],
        ...over,
      },
      repository: { full_name: 'SidCorp-co/forge' },
    };
  }

  it('stores the run under GitHub`s own id with its app and head', async () => {
    await open();
    expect(await g.mods.applyCheckRunEvent(g.ctx(), checkEvent())).toBe(1);
    const checks = (await g.row())?.checks as Record<string, Record<string, unknown>>;
    expect(checks['900']).toMatchObject({
      name: 'ci-passed',
      app: 'github-actions',
      headSha: H1,
      conclusion: 'success',
    });
  });

  it('finds the pull request by head sha where GitHub named none', async () => {
    await open();
    expect(await g.mods.applyCheckRunEvent(g.ctx(), checkEvent({ pull_requests: [] }))).toBe(1);
    expect(Object.keys((await g.row())?.checks as object)).toEqual(['900']);
  });

  it('writes nothing for a delivery naming a pull request the projection does not hold', async () => {
    await open();
    const written = await g.mods.applyCheckRunEvent(
      g.ctx(),
      checkEvent({ pull_requests: [{ number: 999 }], head_sha: 'e'.repeat(40) }),
    );
    expect(written).toBe(0);
  });

  it('keeps the completed state when the run`s own queued delivery arrives after it', async () => {
    await open();
    await g.mods.applyCheckRunEvent(g.ctx(), checkEvent());
    await g.mods.applyCheckRunEvent(
      g.ctx(),
      checkEvent({ status: 'queued', conclusion: null, completed_at: null }),
    );
    const checks = (await g.row())?.checks as Record<string, Record<string, unknown>>;
    expect(checks['900']?.status).toBe('completed');
  });

  it('stores a run for a head the row has left and leaves the current head`s rollup alone', async () => {
    await open();
    await g.mods.applyCheckRunEvent(g.ctx(), checkEvent());
    await g.mods.applyCheckRunEvent(
      g.ctx(),
      checkEvent({
        id: 901,
        head_sha: H2,
        conclusion: 'failure',
        pull_requests: [{ number: 77 }],
      }),
    );
    const checks = (await g.row())?.checks as Record<string, unknown>;
    expect(Object.keys(checks).sort()).toEqual(['900', '901']);

    const issueId = String((await g.row())?.issue_id);
    const projected = await g.mods.readPullRequestsForIssues([issueId]);
    expect(projected.get(issueId)?.[0]?.checks).toEqual({
      total: 1,
      success: 1,
      failure: 0,
      pending: 0,
    });
  });
});

describe('a pull_request_review delivery', () => {
  async function open() {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
  }

  function reviewEvent(over: Record<string, unknown> = {}) {
    return {
      action: 'submitted',
      review: {
        id: 555,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-17T01:30:00Z',
        html_url: 'https://github.com/x#r555',
        user: { login: 'codex' },
      },
      pull_request: { number: 77 },
      ...over,
    };
  }

  it('stores the reviewer and the state, lower-cased as GitHub`s API spells it', async () => {
    await open();
    expect(await g.mods.applyReviewEvent(g.ctx(), reviewEvent())).toBe(1);
    const reviews = (await g.row())?.reviews as Record<string, Record<string, unknown>>;
    expect(reviews['555']).toMatchObject({
      reviewer: 'codex',
      state: 'changes_requested',
      dismissed: false,
    });
  });

  it('keeps a dismissal when the submission it dismissed is redelivered after it', async () => {
    await open();
    await g.mods.applyReviewEvent(g.ctx(), reviewEvent({ action: 'dismissed' }));
    await g.mods.applyReviewEvent(g.ctx(), reviewEvent());
    const reviews = (await g.row())?.reviews as Record<string, Record<string, unknown>>;
    expect(reviews['555']?.dismissed).toBe(true);
  });

  it('writes nothing for a review on a pull request the projection does not hold', async () => {
    await open();
    expect(
      await g.mods.applyReviewEvent(g.ctx(), { ...reviewEvent(), pull_request: { number: 999 } }),
    ).toBe(0);
  });
});

/**
 * ISS-1123 criteria 1 to 6 — the second route to this writer, against the real statement.
 *
 * The ordering case is here rather than in a unit file for the reason the header gives: the rule it
 * turns on lives in the `ON CONFLICT` predicate, and a stubbed builder passes it with that
 * predicate deleted. What it proves is that the creation answer cannot rewind a row a later
 * delivery already moved — which it can, and silently, the moment its `updated_at` stops travelling.
 */
describe('a pull request the agent face opened', () => {
  const opened = (over: Record<string, unknown> = {}) => ({
    number: 77,
    url: 'https://github.com/SidCorp-co/forge/pull/77',
    title: 'a change under review',
    state: 'open',
    draft: false,
    headRef: 'ISS-4242-projection',
    headSha: H1,
    baseRef: 'main',
    baseSha: BASE,
    updatedAt: '2026-09-17T01:00:00Z',
    ...over,
  });

  const project = (over: Record<string, unknown> = {}) =>
    g.mods.projectOpenedPullRequest({
      projectId: g.projectId,
      bindingId: g.bindingId,
      repository: 'SidCorp-co/forge',
      opened: opened(over) as Parameters<typeof g.mods.projectOpenedPullRequest>[0]['opened'],
    });

  it('leaves a row the merge route can resolve, linked to the issue its branch names', async () => {
    const issueId = await g.seedIssue(g.projectId, 4242);
    const result = await project();
    expect(result).toMatchObject({ outcome: 'recorded', issueId });
    expect(await g.row()).toMatchObject({
      issue_id: issueId,
      number: 77,
      state: 'open',
      head_ref: 'ISS-4242-projection',
      head_sha: H1,
      base_ref: 'main',
      base_sha: BASE,
      repo_full_name: 'SidCorp-co/forge',
      merged_at: null,
      merge_commit_sha: null,
    });
  });

  it('links to no issue where the branch names none, which is an ordinary answer', async () => {
    const result = await project({ headRef: 'dependabot/npm/hono-4' });
    expect(result).toMatchObject({ outcome: 'recorded', issueId: null });
    expect((await g.row())?.issue_id).toBeNull();
  });

  it('cannot rewind a row a newer delivery already moved, and says it did not', async () => {
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        state: 'closed',
        merged: true,
        merged_at: '2026-09-18T04:00:00Z',
        merge_commit_sha: 'e'.repeat(40),
        head: { ref: 'ISS-4242-projection', sha: H2 },
        updated_at: '2026-09-18T04:00:00Z',
      }),
    );

    const result = await project({ updatedAt: '2026-09-17T01:00:00Z' });

    expect(result.outcome).toBe('superseded');
    expect(await g.row()).toMatchObject({
      state: 'merged',
      head_sha: H2,
      merge_commit_sha: 'e'.repeat(40),
    });
  });

  it('refuses by name rather than writing a row without the head GitHub never sent', async () => {
    await expect(project({ headSha: null })).rejects.toThrow(/head sha/);
    expect(await g.row()).toBeUndefined();
  });
});
