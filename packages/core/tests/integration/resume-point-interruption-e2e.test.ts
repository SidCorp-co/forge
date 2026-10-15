/**
 * ISS-1133 criterion 13 — a session interrupted mid-phase is succeeded by one whose resume-point
 * names the newest phase started and never ended, through the phase REST routes a driver is told
 * to use (`prompt/facts/drive-rules.ts`). It runs unchanged on the store under those routes, so the
 * same file is the "before" on `phase_journal` and the "after" on the table that replaces it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [phases, errMod, reqIdMod, jwt] = await Promise.all([
    import('../../src/pipeline/phase-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/pipeline-runs', phases.phaseRoutes);
  app.onError(errMod.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** A running issue run and the credential of the session driving it. */
async function seedRun() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}::uuid`,
  );
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status)
    VALUES (${issueId}::uuid, ${project.id}::uuid, 'a run that is interrupted', ${user.id}::uuid, 'in_progress')
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', now())
  `);
  return { runId, token: await signUserToken(user.id) };
}

/** One driver session: it speaks to the run only through the REST routes. */
function session(runId: string, token: string) {
  const call = (path: string, method: 'GET' | 'POST', body?: unknown) =>
    app.request(`/api/pipeline-runs/${runId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    async start(phase: string): Promise<number> {
      const res = await call('/phases', 'POST', { phase });
      expect(res.status).toBe(201);
      return ((await res.json()) as { attempt: number }).attempt;
    },
    async end(phase: string, attempt: number): Promise<void> {
      const res = await call('/phases/end', 'POST', { phase, attempt, outcome: 'ok' });
      expect(res.status).toBe(200);
    },
    async resumePoint(): Promise<{ phase: string; attempt: number } | null> {
      const res = await call('/resume-point', 'GET');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resumePoint: { phase: string; attempt: number } | null;
      };
      return (
        body.resumePoint && { phase: body.resumePoint.phase, attempt: body.resumePoint.attempt }
      );
    },
  };
}

describe('a session interrupted mid-phase (ISS-1133 criterion 13)', () => {
  it('leaves its successor the newest phase it started and never ended', async () => {
    const { runId, token } = await seedRun();
    const first = session(runId, token);
    expect(await first.resumePoint()).toBeNull();

    await first.end('plan', await first.start('plan'));
    await first.start('implement');
    // The first session dies here: `implement` was declared and never ended.

    const successor = session(runId, token);
    expect(await successor.resumePoint()).toEqual({ phase: 'implement', attempt: 1 });
  });

  it('names the re-entered attempt when the successor is interrupted in the same phase', async () => {
    const { runId, token } = await seedRun();
    const first = session(runId, token);
    await first.end('plan', await first.start('plan'));
    await first.start('implement');

    const second = session(runId, token);
    expect(await second.start('implement')).toBe(2);
    // The second session dies in its own `implement`.

    const third = session(runId, token);
    expect(await third.resumePoint()).toEqual({ phase: 'implement', attempt: 2 });
  });

  it('names nothing once every phase a session declared has ended', async () => {
    const { runId, token } = await seedRun();
    const only = session(runId, token);
    await only.end('plan', await only.start('plan'));
    await only.end('implement', await only.start('implement'));

    expect(await session(runId, token).resumePoint()).toBeNull();
  });
});
