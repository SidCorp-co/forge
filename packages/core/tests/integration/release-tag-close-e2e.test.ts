// @gate-input whole-tree — it serves a real repository through a fake `ssh` on PATH, which the root-walk guard cannot see into.
/**
 * ISS-1391 — on a project that ships by version tag, `closed` is refused unless a tag matching the
 * project's pattern contains the issue's landing commit, through the real transition and batch
 * routes, a real Postgres, and a real repository read as the project's deploy key (the fixture of
 * `tests/helpers/git-host-fixture.ts`, which serves tags through git itself).
 *
 * The case ISS-1391 was filed on is the first one: an issue merged past the newest tag goes red
 * with the refusal, and the SAME issue goes green after a tag that contains it is cut, with nothing
 * edited between the two.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';
process.env.PAT_PEPPER ??= 'integration-test-pat-pepper-padded-to-32-chars-long';

import { GITHUB_NOT_FOUND } from '../../src/git/host-answers.fixture.js';
import {
  attachDeployKey,
  GITLAB_URL,
  type GitHost,
  startGitHost,
} from '../helpers/git-host-fixture.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('node:dns', async (importOriginal) =>
  (await import('../helpers/git-host-fixture.js')).publicDns(await importOriginal()),
);

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
let host: GitHost;
const at: Record<string, string> = {};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, extrasMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/extras-routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.route('/api/issues', extrasMod.issueExtrasRoutes);
  app.onError(errMod.errorHandler);

  host = startGitHost();
  at.root = host.commit('main', 'chore: root');
  host.publish();
}, 120_000);

afterAll(async () => {
  host?.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  host.answering(null);
  await truncateAll(harness.db);
});

/** A commit on main nobody has tagged, which is what one case's issue lands as. */
function fresh(message = 'fix(core): the work'): string {
  const sha = host.commit('main', message);
  host.publish();
  return sha;
}

function tagAt(name: string, sha: string, annotated = false): void {
  host.tag(name, sha, annotated);
  host.publish();
}

interface World {
  projectId: string;
  agentToken: string;
  humanToken: string;
  userId: string;
}

/** A project shipping by tag `v*`, on a deploy key, with one agent and one human holding a token. */
async function seedWorld(chain: unknown[]): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, human.id);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  await harness.db.execute(
    sql`UPDATE projects SET release_chain = ${JSON.stringify(chain)}::jsonb, base_branch = 'main' WHERE id = ${project.id}::uuid`,
  );
  await attachDeployKey(harness.db, project.id, GITLAB_URL);
  const mint = (userId: string, name: string) =>
    mintPat({ userId, name, boundProjectId: project.id }).then((m) => m.plaintext);
  return {
    projectId: project.id,
    agentToken: await mint(agent.id, 'an agent'),
    humanToken: await mint(human.id, 'a person'),
    userId: human.id,
  };
}

async function seedIssue(
  w: World,
  opts: { status?: string; commit: string | null; claimed?: string | null },
): Promise<string> {
  const id = randomUUID();
  const commit = opts.commit;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status, merged_at, merged_commit_sha,
                        merged_claimed_commit, release_notes)
    VALUES (${id}::uuid, ${w.projectId}::uuid, 'work whose release is a tag', ${w.userId}::uuid,
            ${opts.status ?? 'awaiting_release'}, now(), ${commit ?? null},
            ${opts.claimed ?? null}, '{"section":"Skip","userFacing":"-"}'::jsonb)
  `);
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}::uuid`,
  );
  return (rows[0] as { status: string }).status;
}

const close = (id: string, token: string) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ toStatus: 'closed' }),
  });

type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

const shipsBy = (tag: string) => [{ branch: 'main', tag }];

describe('POST /api/issues/:id/transition to closed, on a project that ships by tag', () => {
  it('refuses a landing no matching tag contains, then closes the same issue once one does (criteria 5, 7)', async () => {
    const w = await seedWorld(shipsBy('a-v*'));
    tagAt('a-v1.0.0', at.root as string);
    const landing = fresh();
    const id = await seedIssue(w, { commit: landing });

    const refused = await close(id, w.humanToken);

    expect(refused.status).toBe(422);
    const body = (await refused.json()) as Refusal;
    expect(body.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(body.message).toContain(landing);
    expect(body.message).toContain('`a-v1.0.0`');
    expect(body.message).toContain('rests at Awaiting release');
    expect(body.details).toMatchObject({
      pattern: 'a-v*',
      landing,
      newestTag: 'a-v1.0.0',
      matchingTags: 1,
      rests: 'awaiting_release',
    });
    expect(await statusOf(id)).toBe('awaiting_release');

    tagAt('a-v1.1.0', fresh('fix(core): merged after it'), true);

    const closed = await close(id, w.humanToken);
    expect(closed.status).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  }, 120_000);

  it('refuses an agent too, from testing as from awaiting_release, and does not hold its close at the gate (criteria 6, 10)', async () => {
    const w = await seedWorld(shipsBy('b-v*'));
    const landing = fresh();
    for (const status of ['testing', 'awaiting_release']) {
      const id = await seedIssue(w, { status, commit: landing });

      const res = await close(id, w.agentToken);

      expect(res.status, status).toBe(422);
      expect(((await res.json()) as Refusal).code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
      expect(await statusOf(id)).toBe(status);
    }
  }, 120_000);

  it('lets an agent close once a tag contains the landing, with no live deploy binding on the project (criterion 10)', async () => {
    const w = await seedWorld(shipsBy('c-v*'));
    const landing = fresh();
    tagAt('c-v2.0.0', landing);
    const id = await seedIssue(w, { status: 'testing', commit: landing });

    const res = await close(id, w.agentToken);

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  }, 120_000);

  it('does not count a tag the pattern does not name, however plainly it holds the landing (criterion 8)', async () => {
    const landing = fresh();
    tagAt('d-nightly-1', landing);

    const counted = await seedWorld(shipsBy('d-nightly-*'));
    expect(
      (await close(await seedIssue(counted, { commit: landing }), counted.humanToken)).status,
    ).toBe(200);

    const other = await seedWorld(shipsBy('d-release-*'));
    const refused = await close(await seedIssue(other, { commit: landing }), other.humanToken);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Refusal).details).toMatchObject({
      newestTag: null,
      matchingTags: 0,
    });
  }, 120_000);

  it('refuses RELEASE_TAG_UNREAD, 503, where the host cannot be read, and closes nothing (criterion 9)', async () => {
    const w = await seedWorld(shipsBy('e-v*'));
    const landing = fresh();
    const id = await seedIssue(w, { commit: landing });
    host.answering(GITHUB_NOT_FOUND);

    const res = await close(id, w.humanToken);

    expect(res.status).toBe(503);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe('RELEASE_TAG_UNREAD');
    expect(body.details).toMatchObject({ read: 'unread', landing });
    expect(await statusOf(id)).toBe('awaiting_release');
  }, 120_000);

  it('refuses an issue carrying no landing commit, saying so (criterion 9)', async () => {
    const w = await seedWorld(shipsBy('f-v*'));
    const id = await seedIssue(w, { commit: null });

    const res = await close(id, w.humanToken);

    expect(res.status).toBe(422);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe('CLOSE_REQUIRES_RELEASE_TAG');
    expect(body.message).toContain('carries no landing commit');
    expect(await statusOf(id)).toBe('awaiting_release');
  }, 120_000);

  it('looks for the commit a caller claimed where none was observed', async () => {
    const w = await seedWorld(shipsBy('g-v*'));
    const landing = fresh();
    tagAt('g-v3.0.0', landing);
    const id = await seedIssue(w, { commit: null, claimed: landing.slice(0, 12) });

    expect((await close(id, w.humanToken)).status).toBe(200);
  }, 120_000);
});

describe('a project that names no tag closes as it did (criterion 11)', () => {
  it.each([
    ['ships nothing', []],
    ['publishes one branch', [{ branch: 'main' }]],
  ])(
    'where its chain %s, a human close needs no tag',
    async (_, chain) => {
      const w = await seedWorld(chain);
      const id = await seedIssue(w, { commit: fresh() });

      expect((await close(id, w.humanToken)).status).toBe(200);
      expect(await statusOf(id)).toBe('closed');
    },
    120_000,
  );

  it('and an agent close on a chain that ships nothing lands at closed, never read against a tag', async () => {
    const w = await seedWorld([]);
    const id = await seedIssue(w, { status: 'testing', commit: fresh() });

    expect((await close(id, w.agentToken)).status).toBe(200);
    expect(await statusOf(id)).toBe('closed');
  }, 120_000);
});

describe('PATCH /api/issues/batch (criterion 13)', () => {
  it('reports the refusal per issue with its own skip reason, and closes the one a tag carries', async () => {
    const w = await seedWorld(shipsBy('h-v*'));
    const carriedAt = fresh();
    tagAt('h-v1.0.0', carriedAt);
    const carried = await seedIssue(w, { commit: carriedAt });
    const uncarried = await seedIssue(w, { commit: fresh('fix(core): after every tag') });

    const patch = (ids: string[]) =>
      app.request('/api/issues/batch', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${w.humanToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ids, data: { status: 'closed' } }),
      });

    const res = await patch([carried, uncarried]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: Array<{ id: string }>;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(body.updated.map((u) => u.id)).toEqual([carried]);
    expect(body.skipped).toEqual([
      {
        id: uncarried,
        reason: 'close_requires_release_tag',
        code: 'CLOSE_REQUIRES_RELEASE_TAG',
        message: expect.any(String),
      },
    ]);
    expect(await statusOf(uncarried)).toBe('awaiting_release');

    host.answering(GITHUB_NOT_FOUND);
    const unread = await seedIssue(w, { commit: carriedAt });
    const again = await patch([unread]);
    expect(((await again.json()) as { skipped: unknown[] }).skipped).toEqual([
      {
        id: unread,
        reason: 'release_tag_unread',
        code: 'RELEASE_TAG_UNREAD',
        message: expect.any(String),
      },
    ]);
  }, 180_000);
});
