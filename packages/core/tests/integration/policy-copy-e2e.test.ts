/**
 * ISS-1303 — the policy copy a box ran under, carried onto the run it opens,
 * through the real open route and real Postgres.
 *
 * What the unit tests cannot say is that the crossing holds: the body the box
 * sends is validated by the route, written under the run's metadata inside the
 * one transaction that mints the run, and read back by the route a reviewer
 * uses. The bodies planted here are the fixture `daemon/policy_copy.rs` also
 * asserts, `src/devices/policy-copy.fixture.json`.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

const fixture = JSON.parse(
  readFileSync(new URL('../../src/devices/policy-copy.fixture.json', import.meta.url), 'utf8'),
) as {
  accepted: Array<{ case: string; body: Record<string, unknown> }>;
  refused: Array<{ case: string; body: unknown; names: string }>;
};

const named = fixture.accepted.find((a) => a.body.named === true && 'commit' in a.body)
  ?.body as Record<string, unknown>;

describe('a run a box opens carries the policy copy the box named', () => {
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

  async function box() {
    const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    const project = await createTestProject(harness.db, user.id);
    const jwt = await signUserToken(user.id);
    const device = await pairMockDevice({ server, projectId: project.id, userJwt: jwt });
    // Admission reads a runner on this project for this device (ISS-1109).
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      VALUES (gen_random_uuid(), ${project.id}, 'claude-code', ${device.id},
              'policy-runner', 'online', now())
      ON CONFLICT DO NOTHING
    `);
    return { user, project, jwt, device };
  }

  const open = (
    token: string,
    body: { projectId: string; runId: string; issueKeys: string[]; name: string; policy?: unknown },
  ) =>
    fetch(`${server.baseUrl}/api/devices/me/run-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function opened(
    b: Awaited<ReturnType<typeof box>>,
    policy: unknown,
    over: { runId?: string; issueKeys?: string[] } = {},
  ) {
    const res = await open(b.device.token, {
      projectId: b.project.id,
      runId: over.runId ?? randomUUID(),
      issueKeys: over.issueKeys ?? ['ISS-1'],
      name: 'ISS-1',
      ...(policy === undefined ? {} : { policy }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { sessionId: string; runId: string };
  }

  /** The run as a reviewer reads it: over its own route, as the project owner. */
  async function reviewerReads(b: Awaited<ReturnType<typeof box>>, runId: string) {
    const res = await fetch(`${server.baseUrl}/api/pipeline-runs/${runId}`, {
      headers: { authorization: `Bearer ${b.jwt}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { policyAtOpen: unknown }).policyAtOpen;
  }

  const rowsOf = async (table: 'pipeline_runs' | 'agent_sessions' | 'issue_leases') =>
    Number(
      (
        (await harness.db.execute(
          sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`,
        )) as unknown as Array<{ n: number }>
      )[0]?.n,
    );

  it('reads back the copy the box named, exactly', async () => {
    const b = await box();
    const run = await opened(b, named);
    expect(await reviewerReads(b, run.runId)).toEqual({ read: 'ok', policy: named });
  });

  // The ruling of 2026-09-30: a runner too old to send it records "none named".
  it('records that a box which sent no policy named none', async () => {
    const b = await box();
    const run = await opened(b, undefined);
    expect(await reviewerReads(b, run.runId)).toEqual({
      read: 'ok',
      policy: { named: false, reason: 'not_reported' },
    });
  });

  it.each(fixture.accepted.filter((a) => a.body.named === false))(
    'reads back what a box that could not name a copy said: $case',
    async ({ body }) => {
      const b = await box();
      const run = await opened(b, body);
      const seen = (await reviewerReads(b, run.runId)) as { policy: Record<string, unknown> };
      expect(seen.policy).toEqual(body);
      expect(seen.policy).not.toHaveProperty('version');
    },
  );

  it('keeps the first stamp when the same box run is opened again with another copy', async () => {
    const b = await box();
    const runId = randomUUID();
    const first = await opened(b, named, { runId });
    const second = await opened(b, { named: false, reason: 'plugins_unknown' }, { runId });
    expect(second.runId).toBe(first.runId);
    expect(await reviewerReads(b, first.runId)).toEqual({ read: 'ok', policy: named });
  });

  it.each(fixture.refused)('refuses $case by name and opens nothing', async ({ body, names }) => {
    const b = await box();
    const res = await open(b.device.token, {
      projectId: b.project.id,
      runId: randomUUID(),
      issueKeys: ['ISS-1'],
      name: 'ISS-1',
      policy: body,
    });
    expect(res.status).toBe(400);
    const said = await res.text();
    expect(said).toContain('policy');
    expect(said).toContain(names);
    expect(await rowsOf('pipeline_runs')).toBe(0);
    expect(await rowsOf('agent_sessions')).toBe(0);
    expect(await rowsOf('issue_leases')).toBe(0);
  });

  it('reads none for a run opened before the stamp existed, and unreadable for one core cannot read', async () => {
    const b = await box();
    const run = await opened(b, named);
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET metadata = metadata - 'policyAtOpen' WHERE id = ${run.runId}`,
    );
    expect(await reviewerReads(b, run.runId)).toBeNull();
    await harness.db.execute(
      sql`UPDATE pipeline_runs
             SET metadata = jsonb_set(metadata, '{policyAtOpen}', '{"named": true, "plugin": "forge"}'::jsonb)
           WHERE id = ${run.runId}`,
    );
    const seen = (await reviewerReads(b, run.runId)) as { read: string; reason?: string };
    expect(seen.read).toBe('unreadable');
    expect(seen.reason).toBeTruthy();
    expect(seen).not.toHaveProperty('policy');
  });
});
