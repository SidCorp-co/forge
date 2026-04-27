import { expect, test } from '@playwright/test';

/**
 * Phase H pipeline self-healing E2E (ISS-306).
 *
 * Verifies the admin observability + manual override surface is live and
 * the sweeper has been writing the expected state. We don't trigger the
 * sweeper directly (it's a 60s cron); instead we assert that the
 * machinery exists, classifies failures, and that the manual recover
 * endpoint flips a `pipeline_failed` issue back to `confirmed` with
 * recovery counters reset.
 */

const STG_URL = process.env.E2E_WEB_URL ?? 'https://stg-jarvis-a2.thejunix.com';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@thejunix.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin12345';

interface PipelineHealthRow {
  id: string;
  issSeq: number;
  title: string;
  projectSlug: string;
  status: string;
  recoveryAttempts: number;
  lastRecoveryAt: string | null;
  recoveryWindowStartedAt: string | null;
}

interface PipelineHealthResponse {
  escalated: PipelineHealthRow[];
  recovering: PipelineHealthRow[];
  failureBreakdown: Array<{ kind: string; count: number }>;
}

interface RecoverResponse {
  issueId: string;
  status: string;
  recoveryAttempts: number;
  ok: boolean;
}

test.describe('Phase H — pipeline self-healing admin surface', () => {
  test.beforeEach(async ({ context }) => {
    const res = await context.request.post(`${STG_URL}/api/auth/local`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status(), 'admin login should succeed').toBe(200);
  });

  test('GET /api/admin/pipeline/health returns escalated + recovering + breakdown', async ({
    context,
  }) => {
    const res = await context.request.get(`${STG_URL}/api/admin/pipeline/health`);
    expect(res.status()).toBe(200);

    const body = (await res.json()) as PipelineHealthResponse;

    // Shape contract — the dashboard widget reads exactly these fields.
    expect(body).toHaveProperty('escalated');
    expect(body).toHaveProperty('recovering');
    expect(body).toHaveProperty('failureBreakdown');
    expect(Array.isArray(body.escalated)).toBe(true);
    expect(Array.isArray(body.recovering)).toBe(true);
    expect(Array.isArray(body.failureBreakdown)).toBe(true);

    // Each row in escalated/recovering exposes the diagnostic fields the
    // sweeper writes. Missing fields would break the dashboard widget.
    for (const row of [...body.escalated, ...body.recovering]) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('issSeq');
      expect(row).toHaveProperty('status');
      expect(row).toHaveProperty('recoveryAttempts');
      expect(row).toHaveProperty('lastRecoveryAt');
    }

    // failureBreakdown groups failures from the last 24h by classifier kind.
    // Permitted kinds: transient, permanent, unknown, unclassified.
    for (const entry of body.failureBreakdown) {
      expect(['transient', 'permanent', 'unknown', 'unclassified']).toContain(entry.kind);
      expect(entry.count).toBeGreaterThan(0);
    }
  });

  test('non-admin auth is rejected on the health endpoint', async ({ request }) => {
    // Use a fresh request context without the admin cookie. The endpoint
    // sits behind requireAuth + requireAdmin so an anonymous request must
    // 401 (missing token), and a non-admin user — if we had one — would
    // 403. We only assert the unauthenticated case here because creating
    // a non-admin user on staging is out of scope for a smoke spec.
    const res = await request.get(`${STG_URL}/api/admin/pipeline/health`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/admin/pipeline/recover/:id resets counters and unblocks an escalated issue', async ({
    context,
  }) => {
    // Find an issue currently at pipeline_failed (the staging sweeper has
    // already produced one during the v0.1.10 verification run). If the
    // pool is empty, the test is a no-op success — we just confirm the
    // endpoint contract on a known-shape row.
    const healthRes = await context.request.get(`${STG_URL}/api/admin/pipeline/health`);
    const health = (await healthRes.json()) as PipelineHealthResponse;
    const target = health.escalated[0];

    test.skip(!target, 'no pipeline_failed issues on staging right now — skipping recover smoke');

    if (!target) return; // type-narrow

    const recoverRes = await context.request.post(
      `${STG_URL}/api/admin/pipeline/recover/${target.id}`,
    );
    expect(recoverRes.status()).toBe(200);
    const body = (await recoverRes.json()) as RecoverResponse;

    expect(body.ok).toBe(true);
    expect(body.issueId).toBe(target.id);
    // pipeline_failed → confirmed because the endpoint flips it back so
    // the orchestrator picks it up on the next sweeper tick.
    expect(body.status).toBe('confirmed');
    // Counters reset to zero so the issue starts the next recovery
    // window with a fresh budget.
    expect(body.recoveryAttempts).toBe(0);

    // Idempotency: calling recover again on the same issue (now at
    // confirmed) must still 200 and return the same shape — no
    // protective error, the operation is meant to be safe to retry.
    const second = await context.request.post(
      `${STG_URL}/api/admin/pipeline/recover/${target.id}`,
    );
    expect(second.status()).toBe(200);
  });

  test('POST /api/admin/pipeline/recover/:id 404s on a non-existent issue', async ({
    context,
  }) => {
    const fakeId = '00000000-0000-4000-8000-000000000000';
    const res = await context.request.post(
      `${STG_URL}/api/admin/pipeline/recover/${fakeId}`,
    );
    expect(res.status()).toBe(404);
  });

  test('POST /api/admin/pipeline/recover/:id 400s on a malformed uuid', async ({
    context,
  }) => {
    const res = await context.request.post(
      `${STG_URL}/api/admin/pipeline/recover/not-a-uuid`,
    );
    expect(res.status()).toBe(400);
  });
});
