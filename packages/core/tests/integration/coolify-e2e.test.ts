/**
 * ISS-234 — Coolify deploy integration E2E.
 *
 * Drives the real `coolifyAdapter` against real Postgres. Verifies the round
 * trip an operator's webhook would take:
 *   1. dispatchOutbound posts to Coolify (mocked via fetchImpl) and writes
 *      an `integration_deliveries` row with the deployment_uuid.
 *   2. handleInbound verifies the HMAC against the row's integrationSecret
 *      and stamps `pipelineRuns.currentStep` even when the run is already
 *      closed (the release flow closes the run before the deploy outcome
 *      arrives — see release-coolify.ts).
 *   3. Repeated outbound failures within the breaker window flip
 *      `project_integrations.active=false`.
 *
 * Multi-env disambiguation in the inbound router is covered by
 * `inbound-routes.test.ts`; this test focuses on the adapter loop.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';
import type {
  CoolifyConfig,
  CoolifySecrets,
} from '../../src/integrations/coolify/types.js';
import { signHmacSha256 } from '../../src/webhooks/hmac.js';

// Fixed test key so vault encrypt/decrypt is deterministic.
process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type Mods = {
  coolifyAdapter: typeof import('../../src/integrations/coolify/adapter.js').coolifyAdapter;
  encryptJson: typeof import('../../src/integrations/vault.js').encryptJson;
  findById: typeof import('../../src/integrations/store.js').findById;
  buildContext: typeof import('../../src/integrations/store.js').buildContext;
};

describe('ISS-234 — coolify deploy integration E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const adapterMod = await import('../../src/integrations/coolify/adapter.js');
    const vaultMod = await import('../../src/integrations/vault.js');
    const storeMod = await import('../../src/integrations/store.js');
    mods = {
      coolifyAdapter: adapterMod.coolifyAdapter,
      encryptJson: vaultMod.encryptJson,
      findById: storeMod.findById,
      buildContext: storeMod.buildContext,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    vi.restoreAllMocks();
  });

  async function seedIntegration(opts: {
    environment: 'staging' | 'prod';
    secret?: string;
  }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const integrationId = randomUUID();
    const integrationSecret = opts.secret ?? `whsec_test_${integrationId.slice(0, 12)}`;
    const secretsEnc = mods.encryptJson({ apiToken: 'test-token-abc-123' });
    await harness.db.execute(sql`
      INSERT INTO project_integrations
        (id, project_id, provider, environment, config, secrets_enc, integration_secret, active)
      VALUES (
        ${integrationId},
        ${project.id},
        'coolify',
        ${opts.environment},
        ${JSON.stringify({
          baseUrl: 'https://coolify.test',
          resourceUuid: 'res-1',
          branch: 'main',
          environment: opts.environment,
        })}::jsonb,
        ${secretsEnc},
        ${integrationSecret},
        true
      )
    `);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, NULL, 'system', 'completed', NOW())
    `);
    return { project, integrationId, integrationSecret, runId };
  }

  it('outbound dispatch → records delivery with deployment_uuid', async () => {
    const seed = await seedIntegration({ environment: 'staging' });

    // Coolify v4 deploy returns a `deployments[]` array.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ deployments: [{ deployment_uuid: 'deploy-uuid-A', message: 'queued' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const row = await mods.findById(seed.integrationId);
    expect(row).not.toBeNull();
    const ctx = mods.buildContext<CoolifyConfig, CoolifySecrets>(row!);
    const result = await mods.coolifyAdapter.dispatchOutbound(ctx, {
      eventName: 'release.requested',
      runId: seed.runId,
      payload: { runId: seed.runId, issueId: null, environment: 'staging' },
      requestId: `${seed.runId}:${seed.integrationId}`,
    });

    expect(result.externalId).toBe('deploy-uuid-A');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const rows = await harness.db.execute<{
      status: string;
      response: { deployment_uuid?: string } | null;
    }>(sql`
      SELECT status, response FROM integration_deliveries
      WHERE id = ${result.deliveryId}
    `);
    const r = rows[0] as { status: string; response: { deployment_uuid?: string } | null } | undefined;
    expect(r?.status).toBe('ok');
    expect(r?.response?.deployment_uuid).toBe('deploy-uuid-A');
  });

  it('inbound webhook with success status stamps the run', async () => {
    const seed = await seedIntegration({ environment: 'staging' });

    // First record an outbound that the inbound will be matched against.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ deployment_uuid: 'deploy-uuid-B' }), { status: 200 }),
    );
    const row = await mods.findById(seed.integrationId);
    const ctx = mods.buildContext<CoolifyConfig, CoolifySecrets>(row!);
    await mods.coolifyAdapter.dispatchOutbound(ctx, {
      eventName: 'release.requested',
      runId: seed.runId,
      payload: { runId: seed.runId, issueId: null, environment: 'staging' },
    });

    const body = JSON.stringify({
      event: 'deploy.succeeded',
      status: 'success',
      deployment_uuid: 'deploy-uuid-B',
    });
    const signature = signHmacSha256(seed.integrationSecret, body);

    const inbound = await mods.coolifyAdapter.handleInbound(ctx, {
      headers: { 'x-coolify-signature-256': signature },
      rawBody: body,
      payload: JSON.parse(body),
    });

    expect(inbound.actions).toBe(1);
    const runRows = await harness.db.execute<{ current_step: string }>(sql`
      SELECT current_step FROM pipeline_runs WHERE id = ${seed.runId}
    `);
    const runRow = runRows[0] as { current_step?: unknown } | undefined;
    expect(runRow?.current_step).toBe('release.deploy.done');
  });

  it('rejects inbound with bad signature', async () => {
    const seed = await seedIntegration({ environment: 'staging' });
    const row = await mods.findById(seed.integrationId);
    const ctx = mods.buildContext<CoolifyConfig, CoolifySecrets>(row!);

    const body = JSON.stringify({
      event: 'deploy.succeeded',
      status: 'success',
      deployment_uuid: 'whatever',
    });

    await expect(
      mods.coolifyAdapter.handleInbound(ctx, {
        headers: { 'x-coolify-signature-256': 'sha256=deadbeef' },
        rawBody: body,
        payload: JSON.parse(body),
      }),
    ).rejects.toThrow(/signature/i);
  });

  it('three consecutive outbound failures trip the breaker (active=false)', async () => {
    const seed = await seedIntegration({ environment: 'staging' });

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );

    const row = await mods.findById(seed.integrationId);
    const ctx = mods.buildContext<CoolifyConfig, CoolifySecrets>(row!);

    for (let i = 0; i < 3; i++) {
      try {
        await mods.coolifyAdapter.dispatchOutbound(ctx, {
          eventName: 'release.requested',
          runId: seed.runId,
          payload: { runId: seed.runId, issueId: null, environment: 'staging' },
        });
      } catch {
        // expected — non-2xx
      }
    }

    const afterRow = await mods.findById(seed.integrationId);
    expect(afterRow?.active).toBe(false);
    expect(afterRow?.breakerOpenedAt).not.toBeNull();
  });

  it('a tripped breaker blocks further outbound dispatch', async () => {
    const seed = await seedIntegration({ environment: 'staging' });
    await harness.db.execute(sql`
      UPDATE project_integrations SET active = false WHERE id = ${seed.integrationId}
    `);
    const row = await mods.findById(seed.integrationId);
    const ctx = mods.buildContext<CoolifyConfig, CoolifySecrets>(row!);

    await expect(
      mods.coolifyAdapter.dispatchOutbound(ctx, {
        eventName: 'release.requested',
        runId: seed.runId,
        payload: { runId: seed.runId, issueId: null, environment: 'staging' },
      }),
    ).rejects.toThrow(/inactive|circuit breaker/i);
  });
});
