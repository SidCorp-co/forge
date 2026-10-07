/**
 * ISS-1381 — a finish that cannot close an issue says why on that issue. Measured on sid-desk, a
 * batch of 18 closed 15 and left two at `awaiting_release` with a comment naming no reason, while
 * the refusal behind it was `OPEN_QUESTIONS`, found only by sending the move again by hand. Round 3:
 * the acts the comment names are taken through the routes the issue page calls, never the service.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let token: string;
// The routes the issue page calls: its Decision waiting card, its release banner, its status menu.
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [batch, questions, registry, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/questions/routes.js'),
    import('../../src/pipeline/registry-routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.route('/api/questions', questions.questionRoutes);
  app.route('/api/pipeline/registry', registry.pipelineRegistryRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  token = await (await import('../../src/auth/jwt.js')).signUserToken(owner.id);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  // Release now needs a project admin, as the banner's own button does.
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

async function askOn(issueId: string): Promise<string> {
  const id = randomUUID();
  const step = {
    round: 1,
    prompt: 'Which tenant?',
    askedAt: '2026-10-07T10:00:00Z',
    answerShape: 'free_text',
  };
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', 'human', ${JSON.stringify([step])}::jsonb)
  `);
  return id;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res: Response = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface BannerEntry {
  id: string;
  claimedByRunId: string | null;
  closeRefusals: Array<{ code: string }>;
}

/** The issue's entry on the roster the release banner reads; it offers Release now only with no
 *  claim and no close refusal (`awaiting-release-banner.tsx`). */
async function bannerEntry(issueId: string) {
  const roster = await call<{ issues: BannerEntry[] }>(
    'GET',
    `/api/projects/${projectId}/release-batches/roster`,
  );
  expect(roster.status).toBe(200);
  return roster.body.issues.find((i) => i.id === issueId);
}

async function lastComment(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC LIMIT 1
  `);
  return String(rows[0]?.body ?? '');
}

describe('a release finish that cannot close an issue', () => {
  it('names the refusal, each open question and what clears it, and the other issues close', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId, version } = await fx.claim([held, free]);
    const first = await askOn(held);
    const second = await askOn(held);

    const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect(result.closed).toEqual([free]);
    expect((await fx.stored(free)).status).toBe('closed');
    expect((await fx.stored(held)).status).toBe('awaiting_release');
    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${first}`);
    expect(said).toContain(`open question ${second}`);
    expect(said).toContain('"Decision waiting" card');
    expect(said).toContain(`shipped as version ${version}`);
    expect(said).toContain('Release now');
    expect(said).not.toMatch(/\/api\/|voidQuestions/);
  });

  it('names the database’s reason for a close that failed, and never the statement or a bound value', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const broken = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId } = await fx.claim([broken, free]);
    await harness.db.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION planted_close_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'closed' AND NEW.id = '${broken}' THEN
          RAISE EXCEPTION 'planted failure: storage refused this row';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER planted_close_failure BEFORE UPDATE ON issues
        FOR EACH ROW EXECUTE FUNCTION planted_close_failure();
    `),
    );
    try {
      const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

      expect(result.closed).toEqual([free]);
      const said = await lastComment(broken);
      const reason = result.failed.find((f) => f.id === broken)?.reason ?? '';
      for (const text of [said, reason]) {
        expect(text).toContain('planted failure: storage refused this row');
        expect(text).toContain('P0001');
        for (const leaked of ['Failed query', 'update "issues"', 'params:', broken]) {
          expect(text).not.toContain(leaked);
        }
      }
    } finally {
      await harness.db.execute(sql.raw('DROP TRIGGER IF EXISTS planted_close_failure ON issues'));
    }
  });

  it('names the refusal on a batch that recorded a promotion, where the issue stays claimed', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const held = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId, version } = await fx.claim([held, free]);
    await openAttempt({
      runId,
      stage: 'promote',
      idempotencyKey: 'promote-1',
      commit: 'a'.repeat(40),
    });
    const question = await askOn(held);

    const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

    expect(result.closed).toEqual([free]);
    expect((await fx.stored(held)).status).toBe('releasing');
    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${question}`);
    expect(said).toContain(
      'What clears it: answer each open question in its "Decision waiting" card',
    );
    expect(said).toContain(`shipped as version ${version}`);
    expect(said).toContain('stay at `releasing`');
    expect(said).toContain(`/release-batches/${runId}/abort`);
  });

  it('writes the comment as the device owner when a device finished the batch', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId } = await fx.claim([held]);
    const question = await askOn(held);

    await finishReleaseBatch(runId, { type: 'device', id: randomUUID(), ownerId });

    const said = await lastComment(held);
    expect(said).toContain('`OPEN_QUESTIONS`');
    expect(said).toContain(`open question ${question}`);
  });
});

describe('the person’s way out of the release gate (ISS-1381 r3)', () => {
  it('closes the refused issue by the acts its comment names, each taken where the issue page takes it', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const held = await fx.insertIssue();
    const { runId } = await fx.claim([held]);
    const question = await askOn(held);
    await finishReleaseBatch(runId, { type: 'user', id: ownerId });
    expect((await fx.stored(held)).status).toBe('awaiting_release');
    const said = await lastComment(held);

    // The status menu draws the registry's exits: none of them is a move the comment names.
    const registry = await call<{ statusExits: Record<string, string[]> }>(
      'GET',
      '/api/pipeline/registry',
    );
    const exits = registry.body.statusExits.awaiting_release;
    expect(exits).not.toContain('closed');
    expect(said).not.toMatch(/Closed|withdraw/);

    // Before the answer the banner shows the refusal and offers no Release now.
    expect((await bannerEntry(held))?.closeRefusals.map((r) => r.code)).toEqual(['OPEN_QUESTIONS']);

    // The Decision waiting card answers through this route.
    const answered = await call('POST', `/api/questions/${question}/answer`, {
      text: 'the tenant is acme',
      round: 1,
    });
    expect(answered.status).toBe(200);
    expect((await fx.stored(held)).status).toBe('awaiting_release');
    const entry = await bannerEntry(held);
    expect(entry?.closeRefusals).toEqual([]);
    expect(entry?.claimedByRunId).toBeNull();

    // Release now sends this issue alone; the release it starts closes it.
    const released = await call<{ runId: string }>(
      'POST',
      `/api/projects/${projectId}/release-batches`,
      {
        issueIds: [held],
      },
    );
    expect(released.status).toBe(201);
    const second = released.body.runId;
    fx.serve(`commit-pushed-by-run-${second}`);
    await fx.announceMethod(second);
    const result = await finishReleaseBatch(second, { type: 'user', id: ownerId });

    expect(result.closed).toEqual([held]);
    expect((await fx.stored(held)).status).toBe('closed');
  });

  it('names a rule whole whose name holds a value the close bound, and still no statement', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const broken = await fx.insertIssue();
    const free = await fx.insertIssue();
    const { runId } = await fx.claim([broken, free]);
    await harness.db.execute(
      sql.raw(`ALTER TABLE issues ADD CONSTRAINT gj_closed_needs_ledger
        CHECK (status <> 'closed' OR id <> '${broken}') NOT VALID`),
    );
    try {
      const result = await finishReleaseBatch(runId, { type: 'user', id: ownerId });

      expect(result.closed).toEqual([free]);
      const said = await lastComment(broken);
      const reason = result.failed.find((f) => f.id === broken)?.reason ?? '';
      for (const text of [said, reason]) {
        expect(text).toContain('"gj_closed_needs_ledger"');
        expect(text).toContain('23514');
        for (const leaked of ['[Redacted]', 'Failed query', 'update "issues"', 'params:', broken]) {
          expect(text).not.toContain(leaked);
        }
      }
      expect(said).toContain('whoever operates this Forge');
    } finally {
      await harness.db.execute(
        sql.raw('ALTER TABLE issues DROP CONSTRAINT IF EXISTS gj_closed_needs_ledger'),
      );
    }
  });
});
