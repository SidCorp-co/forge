/**
 * ISS-1389 — a run close whose checkpoint declares any source but the one this server reads is
 * refused by name with the valid source, and is not a server error.
 *
 * The close route is the box's only door to that function, so what is claimed is the answer a box
 * gets over it, and that a refused close leaves the run session open to be closed again.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  pairMockDevice,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

describe('closing a run with a checkpoint that declares another source', () => {
  let harness: TestDatabase;
  let server!: TestServer;
  let signUserToken!: typeof import('../../src/auth/jwt.js').signUserToken;

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
    await registerIntegrationsForTest();
    ({ signUserToken } = await import('../../src/auth/jwt.js'));
    server = await startTestServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  const CHECKPOINT = {
    source: 'reconstructed_from_box',
    branch: 'ISS-9-feature',
    head: 'aaaaaaaaaaaa',
    base: 'bbbbbbbbbbbb',
    filesTouched: [],
    commitsAhead: 0,
    commitsUnpushed: 0,
    workingTreeDirty: false,
    endedBy: 'master',
    endedReason: 'closed by hand',
    unread: [],
  };

  async function anOpenRun() {
    const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    const project = await createTestProject(harness.db, user.id);
    const jwt = await signUserToken(user.id);
    const device = await pairMockDevice({ server, projectId: project.id, userJwt: jwt });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      VALUES (gen_random_uuid(), ${project.id}, 'claude-code', ${device.id},
              'close-runner', 'online', now())
      ON CONFLICT DO NOTHING`);
    const opened = await fetch(`${server.baseUrl}/api/devices/me/run-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        runId: randomUUID(),
        issueKeys: ['ISS-1'],
        name: 'ISS-1',
      }),
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const { sessionId } = (await opened.json()) as { sessionId: string };
    return { token: device.token, sessionId };
  }

  const close = (token: string, sessionId: string, checkpoint: unknown) =>
    fetch(`${server.baseUrl}/api/devices/me/run-sessions/${sessionId}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'ended', checkpoint }),
    });

  it.each([
    ['another name', 'something-else'],
    ['the name in another letter case', 'RECONSTRUCTED_FROM_BOX'],
    ['the name with a space after it', 'reconstructed_from_box '],
  ])(
    'refuses %s by name, with the valid source, and not as a server error',
    async (_how, source) => {
      const run = await anOpenRun();

      const res = await close(run.token, run.sessionId, { ...CHECKPOINT, source });
      const text = await res.text();

      expect(res.status, text).toBe(400);
      expect(text).toContain('reconstructed_from_box');
      expect(text).toContain('source');
      expect(text).toContain(JSON.stringify(source).slice(1, -1));
    },
  );

  it('leaves the run session open after a refusal, so the same box can close it with the right source', async () => {
    const run = await anOpenRun();

    expect((await close(run.token, run.sessionId, { ...CHECKPOINT, source: 'x' })).status).toBe(
      400,
    );
    const again = await close(run.token, run.sessionId, CHECKPOINT);

    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyTerminal: false });
  });

  it('closes a run that sends no checkpoint at all as before', async () => {
    const run = await anOpenRun();
    const res = await fetch(
      `${server.baseUrl}/api/devices/me/run-sessions/${run.sessionId}/close`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${run.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'ended' }),
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
  });
});
