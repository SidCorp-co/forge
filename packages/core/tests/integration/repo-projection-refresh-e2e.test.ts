/**
 * The two reads a delivery invalidated, against real Postgres.
 *
 * Every case here is about a WHERE or a bound rather than about a return value:
 * an UPDATE fenced on the target it answered for, a cap that must reach every
 * row past it, and a refusal that must land ON the rows rather than in a log
 * line. None of them can be proved by a stub whose `where` returns itself, which
 * is the proof-by-absence ISS-1071's own F2 was filed for.
 *
 * The payload writers are the sibling suite, `repo-projection-e2e.test.ts`.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE, H1, H2, projectionGround } from './repo-projection-ground.js';

const g = projectionGround();

/** A key that really signs, so a stubbed `fetch` is reached rather than thrown short of. */
const REACHABLE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

describe('a refresh is fenced on the head it answered for', () => {
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

describe('two refreshes for one row are ordered by when they started', () => {
  it('keeps the later-started answer when the earlier-started read finishes last', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    const earlier = new Date('2026-09-17T01:00:00Z');
    const later = new Date('2026-09-17T01:00:05Z');
    const target = { headSha: H1, baseRef: 'main' };
    const facts = (behindBy: number) => ({
      ok: true as const,
      behindBy,
      aheadBy: 1,
      mergeable: true,
      mergeableState: 'clean',
      baseSha: BASE,
    });

    await expect(g.mods.storeRefresh(id, { ...target, startedAt: later }, facts(2))).resolves.toBe(
      true,
    );
    await expect(
      g.mods.storeRefresh(id, { ...target, startedAt: earlier }, facts(99)),
    ).resolves.toBe(false);
    expect((await g.row())?.behind_by).toBe(2);
  });

  it('takes the later-started answer when the reads finish in the order they started', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const id = String((await g.row())?.id);
    const target = { headSha: H1, baseRef: 'main' };
    const facts = (behindBy: number) => ({
      ok: true as const,
      behindBy,
      aheadBy: 1,
      mergeable: true,
      mergeableState: 'clean',
      baseSha: BASE,
    });

    await g.mods.storeRefresh(
      id,
      { ...target, startedAt: new Date('2026-09-17T01:00:00Z') },
      facts(9),
    );
    await expect(
      g.mods.storeRefresh(id, { ...target, startedAt: new Date('2026-09-17T01:00:05Z') }, facts(3)),
    ).resolves.toBe(true);
    expect((await g.row())?.behind_by).toBe(3);
  });
});

describe('a push to a base nothing is waiting on', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes no row and makes no GitHub read', async () => {
    await g.seedIssue(g.projectId, 4242);
    await g.mods.applyPullRequestEvent(g.ctx(), g.prEvent());
    const before = await g.row();
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      throw new Error('a push nothing is based on must not read GitHub');
    });
    const ctx = {
      ...g.ctx(),
      config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
      secrets: { appId: '1', privateKey: REACHABLE_KEY },
    };

    expect(
      await g.mods.applyProjectedEvent(ctx, 'push', {
        ref: 'refs/heads/some-branch-no-pull-request-targets',
        repository: { full_name: 'SidCorp-co/forge' },
      }),
    ).toBe(0);

    expect(calls).toEqual([]);
    const after = await g.row();
    expect(after).toEqual(before);
  });
});

describe('a delivery that cannot read at all says so on the rows', () => {
  const noInstallation = {
    config: { owner: 'SidCorp-co', repo: 'forge' },
    secrets: { appId: '1', privateKey: 'unused — the refusal happens before any signing' },
  };

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
