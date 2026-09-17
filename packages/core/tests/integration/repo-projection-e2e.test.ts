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
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyPullRequestEvent: typeof import('../../src/integrations/github/projection.js').applyPullRequestEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyCheckRunEvent: typeof import('../../src/integrations/github/projection.js').applyCheckRunEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  applyReviewEvent: typeof import('../../src/integrations/github/projection.js').applyReviewEvent;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  storeRefresh: typeof import('../../src/integrations/github/projection-refresh.js').storeRefresh;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  readPullRequestsForIssues: typeof import('../../src/integrations/repo-projection.js').readPullRequestsForIssues;
};

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

describe('the repo projection E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let otherProjectId: string;
  let bindingId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const projection = await import('../../src/integrations/github/projection.js');
    const refresh = await import('../../src/integrations/github/projection-refresh.js');
    const read = await import('../../src/integrations/repo-projection.js');
    mods = {
      applyPullRequestEvent: projection.applyPullRequestEvent,
      applyCheckRunEvent: projection.applyCheckRunEvent,
      applyReviewEvent: projection.applyReviewEvent,
      storeRefresh: refresh.storeRefresh,
      readPullRequestsForIssues: read.readPullRequestsForIssues,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    otherProjectId = (await createTestProject(harness.db, owner.id)).id;

    const connectionId = randomUUID();
    bindingId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${owner.id}, 'github', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, active, config)
      VALUES (${bindingId}, ${connectionId}, ${projectId}, 'github', 'service', ARRAY[]::text[], true, '{}'::jsonb)
    `);
  });

  const ctx = () => ({ projectId, bindingId });

  async function seedIssue(target: string, issSeq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, description, created_by_id, status, iss_seq, created_via)
      VALUES (${id}, ${target}, ${`planted ${issSeq}`}, null, ${ownerId}, 'open', ${issSeq}, 'system')
    `);
    return id;
  }

  function prEvent(over: Record<string, unknown> = {}) {
    return {
      action: 'opened',
      pull_request: {
        number: 77,
        title: 'a change under review',
        html_url: 'https://github.com/SidCorp-co/forge/pull/77',
        state: 'open',
        draft: false,
        updated_at: '2026-09-17T01:00:00Z',
        head: { ref: 'ISS-4242-projection', sha: H1 },
        base: { ref: 'main', sha: BASE },
        ...over,
      },
      repository: { full_name: 'SidCorp-co/forge' },
    };
  }

  async function row() {
    const rows = (await harness.db.execute(sql`
      SELECT * FROM repo_pull_requests WHERE binding_id = ${bindingId} AND number = 77
    `)) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  describe('a pull_request delivery', () => {
    it('stores the head, the base, the state and the link to the branch`s issue', async () => {
      const issueId = await seedIssue(projectId, 4242);
      expect(await mods.applyPullRequestEvent(ctx(), prEvent())).toBe(1);
      const r = await row();
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
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ head: { ref: 'ISS-4242-projection', sha: H2 }, updated_at: '2026-09-17T02:00:00Z' }),
      );
      expect((await row())?.head_sha).toBe(H2);
    });

    it('stores merged apart from closed, with the commit GitHub named', async () => {
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({
          state: 'closed',
          merged: true,
          merged_at: '2026-09-17T03:00:00Z',
          merge_commit_sha: 'd'.repeat(40),
          updated_at: '2026-09-17T03:00:00Z',
        }),
      );
      const r = await row();
      expect(r?.state).toBe('merged');
      expect(r?.merge_commit_sha).toBe('d'.repeat(40));
    });

    it('stores a close that is not a merge as closed with no merge commit', async () => {
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ state: 'closed', merged: false, updated_at: '2026-09-17T03:00:00Z' }),
      );
      const r = await row();
      expect(r?.state).toBe('closed');
      expect(r?.merge_commit_sha).toBeNull();
    });

    // cm:guard the ONE case the `setWhere` exists for. Delete that clause and this goes red naming the head it rewound to, which is what a retried or delayed `synchronize` does in the field.
    it('leaves every scalar alone when an older payload arrives after a newer one', async () => {
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ head: { ref: 'ISS-4242-projection', sha: H2 }, updated_at: '2026-09-17T02:00:00Z' }),
      );
      const written = await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ title: 'stale title', updated_at: '2026-09-17T01:00:00Z' }),
      );
      expect(written).toBe(0);
      const r = await row();
      expect(r?.head_sha).toBe(H2);
      expect(r?.title).toBe('a change under review');
    });

    // cm:guard the `CASE WHEN head_sha = excluded.head_sha` arms. Without them a behind-by computed for H1 survives beside H2 and reads as current, which is the number this whole projection exists to stop being wrong.
    it('clears what described the previous head in the statement that moves the head', async () => {
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.storeRefresh(String((await row())?.id), H1, {
        ok: true,
        behindBy: 9,
        aheadBy: 2,
        mergeable: false,
        mergeableState: 'dirty',
        baseSha: BASE,
      });
      expect(await row()).toMatchObject({ behind_by: 9, mergeable_state: 'dirty' });

      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ head: { ref: 'ISS-4242-projection', sha: H2 }, updated_at: '2026-09-17T02:00:00Z' }),
      );
      const r = await row();
      expect(r?.behind_by).toBeNull();
      expect(r?.ahead_by).toBeNull();
      expect(r?.mergeable_state).toBeNull();
      expect(r?.refreshed_for_head).toBeNull();
    });

    it('keeps a refresh that describes the head the payload also carries', async () => {
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.storeRefresh(String((await row())?.id), H1, {
        ok: true,
        behindBy: 4,
        aheadBy: 1,
        mergeable: true,
        mergeableState: 'clean',
        baseSha: BASE,
      });
      await mods.applyPullRequestEvent(ctx(), prEvent({ title: 'renamed', updated_at: '2026-09-17T02:00:00Z' }));
      const r = await row();
      expect(r?.title).toBe('renamed');
      expect(r?.behind_by).toBe(4);
    });

    it('links no issue where the branch names one belonging to another project', async () => {
      await seedIssue(otherProjectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
      expect((await row())?.issue_id).toBeNull();
    });

    it('links no issue where the branch names none', async () => {
      await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ head: { ref: 'dependabot/npm_and_yarn/vite-5', sha: H1 } }),
      );
      expect((await row())?.issue_id).toBeNull();
    });
  });

  describe('a check_run delivery', () => {
    async function open() {
      await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
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
      expect(await mods.applyCheckRunEvent(ctx(), checkEvent())).toBe(1);
      const checks = (await row())?.checks as Record<string, Record<string, unknown>>;
      expect(checks['900']).toMatchObject({
        name: 'ci-passed',
        app: 'github-actions',
        headSha: H1,
        conclusion: 'success',
      });
    });

    it('finds the pull request by head sha where GitHub named none', async () => {
      await open();
      expect(await mods.applyCheckRunEvent(ctx(), checkEvent({ pull_requests: [] }))).toBe(1);
      expect(Object.keys((await row())?.checks as object)).toEqual(['900']);
    });

    it('writes nothing for a delivery naming a pull request the projection does not hold', async () => {
      await open();
      const written = await mods.applyCheckRunEvent(
        ctx(),
        checkEvent({ pull_requests: [{ number: 999 }], head_sha: 'e'.repeat(40) }),
      );
      expect(written).toBe(0);
    });

    it('keeps the completed state when the run`s own queued delivery arrives after it', async () => {
      await open();
      await mods.applyCheckRunEvent(ctx(), checkEvent());
      await mods.applyCheckRunEvent(
        ctx(),
        checkEvent({ status: 'queued', conclusion: null, completed_at: null }),
      );
      const checks = (await row())?.checks as Record<string, Record<string, unknown>>;
      expect(checks['900']?.status).toBe('completed');
    });

    it('stores a run for a head the row has left and leaves the current head`s rollup alone', async () => {
      await open();
      await mods.applyCheckRunEvent(ctx(), checkEvent());
      await mods.applyCheckRunEvent(
        ctx(),
        checkEvent({ id: 901, head_sha: H2, conclusion: 'failure', pull_requests: [{ number: 77 }] }),
      );
      const checks = (await row())?.checks as Record<string, unknown>;
      expect(Object.keys(checks).sort()).toEqual(['900', '901']);

      const issueId = String((await row())?.issue_id);
      const projected = await mods.readPullRequestsForIssues([issueId]);
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
      await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
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
      expect(await mods.applyReviewEvent(ctx(), reviewEvent())).toBe(1);
      const reviews = (await row())?.reviews as Record<string, Record<string, unknown>>;
      expect(reviews['555']).toMatchObject({
        reviewer: 'codex',
        state: 'changes_requested',
        dismissed: false,
      });
    });

    // cm:guard the dismissal and the submission it dismissed arrive unordered and GitHub does not move `submitted_at` on a dismissal, so the flag is the only thing that can carry the answer.
    it('keeps a dismissal when the submission it dismissed is redelivered after it', async () => {
      await open();
      await mods.applyReviewEvent(ctx(), reviewEvent({ action: 'dismissed' }));
      await mods.applyReviewEvent(ctx(), reviewEvent());
      const reviews = (await row())?.reviews as Record<string, Record<string, unknown>>;
      expect(reviews['555']?.dismissed).toBe(true);
    });

    it('writes nothing for a review on a pull request the projection does not hold', async () => {
      await open();
      expect(
        await mods.applyReviewEvent(ctx(), { ...reviewEvent(), pull_request: { number: 999 } }),
      ).toBe(0);
    });
  });

  describe('a refresh is fenced on the head it answered for', () => {
    // cm:guard THE case the `AND head_sha = <captured>` in `storeRefresh` exists for: a slow read for a head the row has since left knows nothing about the head it now carries, so neither its counts nor its complaint belongs there.
    it('writes neither values nor error onto a row whose head has moved', async () => {
      await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
      const id = String((await row())?.id);
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ head: { ref: 'ISS-4242-projection', sha: H2 }, updated_at: '2026-09-17T02:00:00Z' }),
      );

      await expect(
        mods.storeRefresh(id, H1, {
          ok: true,
          behindBy: 99,
          aheadBy: 99,
          mergeable: false,
          mergeableState: 'dirty',
          baseSha: BASE,
        }),
      ).resolves.toBe(false);
      await expect(mods.storeRefresh(id, H1, { ok: false, reason: 'a stale complaint' })).resolves.toBe(
        false,
      );

      const r = await row();
      expect(r?.behind_by).toBeNull();
      expect(r?.refresh_error).toBeNull();
      expect(r?.refreshed_for_head).toBeNull();
    });

    it('records the reason on the row when the read could not answer', async () => {
      await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
      const id = String((await row())?.id);
      await expect(
        mods.storeRefresh(id, H1, { ok: false, reason: 'HTTP 403 on SidCorp-co/forge' }),
      ).resolves.toBe(true);
      const r = await row();
      expect(r?.refresh_error).toBe('HTTP 403 on SidCorp-co/forge');
      expect(r?.head_sha).toBe(H1);
      expect(r?.base_ref).toBe('main');
    });
  });

  describe('what the admissible payload reads', () => {
    it('carries every pull request linked to an issue, open before closed', async () => {
      const issueId = await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent({ number: 10 }));
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({
          number: 10,
          state: 'closed',
          merged: true,
          merged_at: '2026-09-17T03:00:00Z',
          merge_commit_sha: 'f'.repeat(40),
          updated_at: '2026-09-17T03:00:00Z',
        }),
      );
      await mods.applyPullRequestEvent(ctx(), prEvent({ number: 11 }));

      const projected = await mods.readPullRequestsForIssues([issueId]);
      const list = projected.get(issueId) ?? [];
      expect(list.map((p) => [p.number, p.state])).toEqual([
        [11, 'open'],
        [10, 'merged'],
      ]);
    });

    it('answers nothing for an issue with no pull request', async () => {
      const issueId = await seedIssue(projectId, 4242);
      const projected = await mods.readPullRequestsForIssues([issueId]);
      expect(projected.get(issueId)).toBeUndefined();
    });

    // cm:guard the whole point of criterion 28 — green-and-waiting and conflicting must be two different readings of the SAME payload, with no verdict computed for the caller.
    it('tells a green open pull request from a conflicting one', async () => {
      const green = await seedIssue(projectId, 4242);
      const conflicted = await seedIssue(projectId, 4343);
      await mods.applyPullRequestEvent(ctx(), prEvent({ number: 10 }));
      await mods.applyPullRequestEvent(
        ctx(),
        prEvent({ number: 11, head: { ref: 'ISS-4343-other', sha: H2 } }),
      );

      const greenRow = (await harness.db.execute(sql`
        SELECT id FROM repo_pull_requests WHERE binding_id = ${bindingId} AND number = 10
      `)) as unknown as Array<{ id: string }>;
      const badRow = (await harness.db.execute(sql`
        SELECT id FROM repo_pull_requests WHERE binding_id = ${bindingId} AND number = 11
      `)) as unknown as Array<{ id: string }>;

      await mods.storeRefresh(String(greenRow[0]?.id), H1, {
        ok: true,
        behindBy: 0,
        aheadBy: 3,
        mergeable: true,
        mergeableState: 'clean',
        baseSha: BASE,
      });
      await mods.applyCheckRunEvent(ctx(), {
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
      await mods.storeRefresh(String(badRow[0]?.id), H2, {
        ok: true,
        behindBy: 12,
        aheadBy: 1,
        mergeable: false,
        mergeableState: 'dirty',
        baseSha: BASE,
      });

      const projected = await mods.readPullRequestsForIssues([green, conflicted]);
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
      const issueId = await seedIssue(projectId, 4242);
      await mods.applyPullRequestEvent(ctx(), prEvent());
      await mods.applyReviewEvent(ctx(), {
        action: 'submitted',
        review: { id: 1, state: 'APPROVED', submitted_at: '2026-09-17T01:00:00Z', user: { login: 'a' } },
        pull_request: { number: 77 },
      });
      await mods.applyReviewEvent(ctx(), {
        action: 'dismissed',
        review: { id: 2, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-17T01:00:00Z', user: { login: 'b' } },
        pull_request: { number: 77 },
      });
      const projected = await mods.readPullRequestsForIssues([issueId]);
      expect(projected.get(issueId)?.[0]?.reviews).toEqual([{ reviewer: 'a', state: 'approved' }]);
    });
  });
});
