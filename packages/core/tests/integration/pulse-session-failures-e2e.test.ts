/**
 * ISS-1157 — the org Overview's session-failure list, read through `/api/me/pulse` against
 * Postgres rows planted the way the pre-ISS-877 writers left them: prose, a legacy alias and a
 * null beside real cause tokens. Raw SQL plants them because the typed schema refuses prose.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PulseResponse } from '../../src/me/pulse-types.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import { FAILURE_CAUSES } from '../../src/pipeline/failure-causes.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const PROMPT =
  "You are the Forge product-map refresh agent. Your job: keep this project's curated PRODUCT map current";
const DISK = 'failed to start chat turn: io error: No space left on device (os error 28)';
const MARKDOWN = 'Tính năng **publish** đã sẵn sàng — xem ISS-311';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: (userId: string) => Promise<string>;

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

  const { mePulseRoutes } = await import('../../src/me/pulse-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/me', mePulseRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedProject(): Promise<{ projectId: string; token: string; runId: string }> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${project.id}, 'interactive', 'running')`);
  return { projectId: project.id, token: await signUserToken(user.id), runId };
}

async function plantFailed(
  seed: { projectId: string; runId: string },
  reason: string | null,
  times = 1,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status, failure_reason)
      VALUES (${seed.projectId}, ${seed.runId}, 'chat', 'failed', ${reason})`);
  }
}

async function readPulse(token: string): Promise<{ body: PulseResponse; raw: string }> {
  const res = await app.request('/api/me/pulse', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { body: JSON.parse(raw) as PulseResponse, raw };
}

describe('the pulse groups session failures on the cause set (ISS-1157)', () => {
  it('folds prose, a legacy alias and a null into their keys, and carries none of the text', async () => {
    const seed = await seedProject();
    await plantFailed(seed, PROMPT);
    await plantFailed(seed, DISK, 2);
    await plantFailed(seed, MARKDOWN);
    await plantFailed(seed, null);
    await plantFailed(seed, 'job_failed', 2);
    await plantFailed(seed, 'usage_limit');
    await plantFailed(seed, 'ws-publish-failed', 3);
    await plantFailed(seed, 'queue_timeout', 3);

    const { body, raw } = await readPulse(seed.token);

    expect(body.quality.sessionFailures).toEqual([
      { reason: 'unclassified', count: 7 },
      { reason: 'queue_timeout', count: 3 },
      { reason: 'ws_publish_failed', count: 3 },
      { reason: 'provider_usage_limit', count: 1 },
    ]);
    const causes: ReadonlySet<string> = new Set(FAILURE_CAUSES);
    for (const row of body.quality.sessionFailures) expect(causes.has(row.reason)).toBe(true);
    for (const text of [PROMPT, DISK, MARKDOWN, 'No space left', 'product-map', '**publish**']) {
      expect(raw).not.toContain(text);
    }
  });

  it('leaves every stored reason as it was', async () => {
    const seed = await seedProject();
    await plantFailed(seed, PROMPT);
    await plantFailed(seed, 'job_failed');
    await plantFailed(seed, null);
    const before = await harness.db.execute<{ failure_reason: string | null }>(sql`
      SELECT failure_reason FROM agent_sessions ORDER BY failure_reason NULLS FIRST`);

    await readPulse(seed.token);

    const after = await harness.db.execute<{ failure_reason: string | null }>(sql`
      SELECT failure_reason FROM agent_sessions ORDER BY failure_reason NULLS FIRST`);
    expect([...after]).toEqual([...before]);
    expect([...after].map((r) => r.failure_reason)).toContain(PROMPT);
  });
});
