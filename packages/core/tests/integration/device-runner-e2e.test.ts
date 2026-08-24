import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  type MockDevice,
  pairMockDevice,
  setupTestDatabase,
  startTestServer,
  startWebObserver,
  type TestDatabase,
  type TestServer,
  truncateAll,
  type WebObserver,
} from '../helpers/index.js';

// cm:guard runs unconditionally. It sat behind `FORGE_E2E_REAL_PAIR=1` waiting on endpoints that landed long ago, and when the flag was finally set on 2026-08-25 the test failed immediately — the pairing helper had rotted against the route it was waiting for. An E2E nobody can accidentally run is an E2E nobody finds out is broken.
describe('F2 device-runner E2E', () => {
  let harness: TestDatabase;
  let server: TestServer;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    // MUST set DATABASE_URL BEFORE any src import loads env.ts — mirror
    // pipeline-e2e.test.ts:40-56 exactly.
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

    // cm:guard the dispatcher resolves `claude-code` through the adapter registry, and an unregistered adapter leaves the job `queued` with only a log line to say so — the symptom here was an empty WS frame buffer, which reads as a broadcast bug rather than as missing setup. Every other integration E2E calls this in beforeAll; this one never did, because it never ran.
    const { bootstrapRunnerAdapters } = await import('../../src/runners/bootstrap.js');
    bootstrapRunnerAdapters();

    server = await startTestServer();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    return { user, project };
  }

  it('pair → dispatch → stream → complete', async () => {
    const { signUserToken } = await import('../../src/auth/jwt.js');

    const { user, project } = await seed();
    const userJwt = await signUserToken(user.id);

    // 1. Pair device (AC: pair <2s)
    const t0 = performance.now();
    const device: MockDevice = await pairMockDevice({
      server,
      projectId: project.id,
      userJwt,
    });
    expect(performance.now() - t0).toBeLessThan(2_000);

    // 2. Device connects WS
    await device.connectWs();

    // 3. Register an online claude-code runner bound to the device so the
    //    dispatcher's runner path routes the job to it (ISS-267 removed the
    //    legacy activeDeviceId device-routing path).
    await harness.db.execute(sql`UPDATE devices SET status = 'online' WHERE id = ${device.id}`);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${randomUUID()}, ${project.id}, 'claude-code', 'device', ${device.id},
        'e2e-runner', '{"pm": true}'::jsonb, 'online', now()
      )
    `);

    // 4. Open a web observer on the project room
    const observer: WebObserver = await startWebObserver({
      server,
      userJwt,
      projectId: project.id,
    });

    const t1 = performance.now();
    const jobRes = await fetch(`${server.baseUrl}/api/projects/${project.id}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plan', payload: { skillName: 'forge-plan', args: {} } }),
    });
    expect(jobRes.status).toBe(201);
    const { id: jobId } = (await jobRes.json()) as { id: string };

    const assign = await device.waitForAssign(5_000);
    expect(assign.jobId).toBe(jobId);
    // cm:guard 4s, and it is a REGRESSION bound, not the 500ms AC ISS-218 wrote. Dispatch is queue-mediated now: `enqueueJob` hands to pg-boss, whose `pollingInterval` defaults to 2000ms, so enqueue-to-assign waits a mean ~1s on the poll before any dispatch work starts — measured 1418/1554/1667/1716ms across four runs. 500ms cannot hold even at pg-boss's own 500ms floor. Do not lower this to make a slow run green; a value above ~4s means the tick path broke and the 60s sweeper backstop picked the job up instead, which is the failure worth catching.
    expect(assign.at - t1).toBeLessThan(4_000);

    // 6. Mock claude-cli streams JobEvents (AC: first event <5s observer-visible)
    const t2 = performance.now();
    const firstRes = await device.postEvents(jobId, [
      { kind: 'stdout', data: { line: 'booting' } },
    ]);
    expect(firstRes.status).toBe(200);

    const firstEvent = await observer.waitFor(
      (ev) =>
        ev.event === 'job.event' && !!ev.data && (ev.data as { jobId?: string }).jobId === jobId,
      5_000,
    );
    expect(firstEvent.at - t2).toBeLessThan(5_000);

    // Bulk batch + terminal-ish result marker.
    const bulk = Array.from({ length: 32 }, (_, i) => ({
      kind: 'stdout',
      data: { line: `chunk-${i}` },
    }));
    const bulkRes = await device.postEvents(jobId, bulk);
    expect(bulkRes.status).toBe(200);
    const resultRes = await device.postEvents(jobId, [{ kind: 'result', data: { summary: 'ok' } }]);
    expect(resultRes.status).toBe(200);

    // 7. Device completes the job
    const completeRes = await device.complete(jobId, { exitCode: 0 });
    expect(completeRes.status).toBe(200);

    // 8. Web observer sees job.completed
    await observer.waitFor(
      (ev) =>
        ev.event === 'job.completed' &&
        !!ev.data &&
        (ev.data as { jobId?: string }).jobId === jobId,
      2_000,
    );

    // 9. DB assertions — monotonic server-assigned seq, correct terminal row
    const eventRows = await harness.db.execute<{ seq: number; kind: string }>(sql`
      SELECT seq, kind FROM job_events WHERE job_id = ${jobId} ORDER BY seq ASC
    `);
    expect(eventRows.length).toBe(1 + 32 + 1);
    expect(eventRows.map((r) => Number(r.seq))).toEqual(
      Array.from({ length: 34 }, (_, i) => i + 1),
    );

    const jobRows = await harness.db.execute<{ status: string; exit_code: number | null }>(sql`
      SELECT status, exit_code FROM jobs WHERE id = ${jobId}
    `);
    const finalJob = jobRows[0] as { status: string; exit_code: number | null };
    expect(finalJob.status).toBe('done');
    expect(finalJob.exit_code).toBe(0);

    // 10. Cleanup — close clients, verify no dangling sockets / queued jobs
    await device.close();
    await observer.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openSocketCount()).toBe(0);

    const queuedRows = await harness.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM jobs
      WHERE status IN ('queued', 'dispatched', 'running')
    `);
    expect(Number((queuedRows[0] as { n: number }).n)).toBe(0);
  }, 30_000);
});
