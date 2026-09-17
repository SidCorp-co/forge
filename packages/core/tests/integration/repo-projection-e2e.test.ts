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
 * What the stored rows then read as is the sibling suite,
 * `repo-projection-read-e2e.test.ts`.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE, H1, H2, projectionGround } from './repo-projection-ground.js';

// cm:guard the four describes are siblings rather than nested: the size budget measures the longest function, and one `describe` wrapping all four was 250 lines against a budget of 150. The hooks `projectionGround()` registers are file-scoped here, which truncates per test exactly as nesting them did.
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

  // cm:guard the ONE case the `setWhere` exists for. Delete that clause and this goes red naming the head it rewound to, which is what a retried or delayed `synchronize` does in the field.
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

  // cm:guard the `CASE WHEN head_sha = excluded.head_sha` arms. Without them a behind-by computed for H1 survives beside H2 and reads as current, which is the number this whole projection exists to stop being wrong.
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

  // cm:guard the dismissal and the submission it dismissed arrive unordered and GitHub does not move `submitted_at` on a dismissal, so the flag is the only thing that can carry the answer.
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

describe('a refresh is fenced on the head it answered for', () => {
  // cm:guard THE case the `AND head_sha = <captured>` in `storeRefresh` exists for: a slow read for a head the row has since left knows nothing about the head it now carries, so neither its counts nor its complaint belongs there.
  it('writes neither values nor error onto a row whose head has moved', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({
        head: { ref: 'ISS-4242-projection', sha: H2 },
        updated_at: '2026-09-17T02:00:00Z',
      }),
    );

    await expect(
      g.mods.storeRefresh(
        id,
        { headSha: H1, baseRef: 'main' },
        {
          ok: true,
          behindBy: 99,
          aheadBy: 99,
          mergeable: false,
          mergeableState: 'dirty',
          baseSha: BASE,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      g.mods.storeRefresh(
        id,
        { headSha: H1, baseRef: 'main' },
        { ok: false, reason: 'a stale complaint' },
      ),
    ).resolves.toBe(false);

    const r = await g.row();
    expect(r?.behind_by).toBeNull();
    expect(r?.refresh_error).toBeNull();
    expect(r?.refreshed_for_head).toBeNull();
  });

  it('records the reason on the row when the read could not answer', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    await expect(
      g.mods.storeRefresh(
        id,
        { headSha: H1, baseRef: 'main' },
        { ok: false, reason: 'HTTP 403 on SidCorp-co/forge' },
      ),
    ).resolves.toBe(true);
    const r = await g.row();
    expect(r?.refresh_error).toBe('HTTP 403 on SidCorp-co/forge');
    expect(r?.head_sha).toBe(H1);
    expect(r?.base_ref).toBe('main');
  });
});

describe('a refresh is fenced on the base as well as the head', () => {
  // cm:guard the case F1 of the whole-set consult found. A retarget from `main` to `release` does NOT move the head, so a head-only fence lets a refresh computed against `main` land on a row that now says `release` — the same wrong behind-by a stale head would give, reached without anybody pushing anything.
  it('writes nothing onto a row whose base has moved under the same head', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ base: { ref: 'release', sha: BASE }, updated_at: '2026-09-17T02:00:00Z' }),
    );

    await expect(
      g.mods.storeRefresh(
        id,
        { headSha: H1, baseRef: 'main' },
        {
          ok: true,
          behindBy: 99,
          aheadBy: 99,
          mergeable: false,
          mergeableState: 'dirty',
          baseSha: BASE,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      g.mods.storeRefresh(
        id,
        { headSha: H1, baseRef: 'main' },
        { ok: false, reason: 'a stale complaint' },
      ),
    ).resolves.toBe(false);

    const r = await g.row();
    expect(r?.behind_by).toBeNull();
    expect(r?.refresh_error).toBeNull();
  });

  // cm:guard the upsert's own half of F1: the refresh columns describe one head ON ONE BASE, so a payload that moves the base must clear them in the statement that moves it.
  it('clears the refresh facts when the base moves and the head does not', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    await g.mods.storeRefresh(
      id,
      { headSha: H1, baseRef: 'main' },
      {
        ok: true,
        behindBy: 9,
        aheadBy: 2,
        mergeable: true,
        mergeableState: 'clean',
        baseSha: BASE,
      },
    );
    expect((await g.row())?.behind_by).toBe(9);

    await g.mods.applyPullRequestEvent(
      g.ctx(),
      g.prEvent({ base: { ref: 'release', sha: BASE }, updated_at: '2026-09-17T02:00:00Z' }),
    );
    const r = await g.row();
    expect(r?.base_ref).toBe('release');
    expect(r?.behind_by).toBeNull();
    expect(r?.mergeable_state).toBeNull();
    expect(r?.refreshed_for_head).toBeNull();
  });
});

describe('a delivery that cannot read at all says so on the rows', () => {
  const noInstallation = {
    config: { owner: 'SidCorp-co', repo: 'forge' },
    secrets: { appId: '1', privateKey: 'unused — the refusal happens before any signing' },
  };

  // cm:guard F5 of the whole-set consult. A bare null left the row with null counts and nothing beside them, which says "nobody has asked yet" and "Forge cannot ask" in one breath — and only the second is something an operator can act on.
  it('records the missing installation on the pull request it could not read for', async () => {
    await g.seedIssue(g.projectId, 4242);
    const ctx = { ...g.ctx(), ...noInstallation };
    expect(await g.mods.applyProjectedEvent(ctx, 'pull_request', g.prEvent())).toBe(1);
    const r = await g.row();
    expect(String(r?.refresh_error)).toMatch(/install it on the account/i);
    expect(r?.behind_by).toBeNull();
  });

  it('records it on every open pull request a base push invalidated, not on one', async () => {
    const ctx = { ...g.ctx(), ...noInstallation };
    for (const number of [10, 11, 12]) {
      await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent({ number }));
    }
    expect(
      await g.mods.applyProjectedEvent(ctx, 'push', {
        ref: 'refs/heads/main',
        repository: { full_name: 'SidCorp-co/forge' },
      }),
    ).toBe(3);
    for (const number of [10, 11, 12]) {
      expect(String((await g.row(number))?.refresh_error)).toMatch(/install it on the account/i);
    }
  });
});

describe('the cap a base push stops at, against real rows', () => {
  const KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // cm:guard F4 of the whole-set consult. The first shape read `cap + 1` rows and marked the one extra, so a base with 27 open pull requests left two of them stale with no sentence on them — the silent truncation the cap's own message exists to prevent, hiding inside the mechanism meant to prevent it.
  it('refreshes the cap and marks the WHOLE remainder, not one sentinel row', async () => {
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/access_tokens')
          ? { token: 'ghs_x', expires_at: '2099-01-01T00:00:00Z' }
          : String(url).includes('/compare/')
            ? { ahead_by: 1, behind_by: 4, base_commit: { sha: BASE } }
            : {
                head: { sha: H1 },
                base: { ref: 'main' },
                mergeable: true,
                mergeable_state: 'clean',
              },
    }));

    const cap = g.mods.basePushCap;
    const numbers = Array.from({ length: cap + 2 }, (_, i) => 100 + i);
    for (const number of numbers) {
      await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent({ number }));
    }

    const ctx = {
      ...g.ctx(),
      config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
      secrets: { appId: '1', privateKey: KEY },
    };
    await g.mods.applyProjectedEvent(ctx, 'push', {
      ref: 'refs/heads/main',
      repository: { full_name: 'SidCorp-co/forge' },
    });

    const refreshed: number[] = [];
    const capped: number[] = [];
    for (const number of numbers) {
      const r = await g.row(number);
      if (r?.refresh_error === g.mods.capReason) capped.push(number);
      else if (r?.behind_by === 4) refreshed.push(number);
    }
    expect(refreshed).toHaveLength(cap);
    expect(capped).toEqual(numbers.slice(cap));
  }, 60_000);
});
