/**
 * ISS-234 — Coolify deploy integration E2E.
 *
 * Drives the real `coolifyAdapter` against real Postgres. Verifies the round
 * trip an operator's webhook would take:
 *   1. dispatchOutbound posts to Coolify (mocked via fetchImpl) and writes
 *      an `integration_deliveries` row with the deployment_uuid.
 *   2. handleInbound verifies the HMAC against the binding's integrationSecret
 *      and stamps `pipelineRuns.currentStep` even when the run is already
 *      closed (the release flow closes the run before the deploy outcome
 *      arrives — see release-coolify.ts).
 *   3. Repeated outbound failures within the breaker window flip the owning
 *      `integration_connections.active=false`.
 *
 * ISS-410 — the legacy `project_integrations` table was dropped; the data now
 * lives in `integration_connections` (the credential, which carries the
 * active/breaker state) + `integration_bindings` (the per-project+env link,
 * which carries config overrides + the inbound HMAC secret). The adapter
 * resolves a binding+connection pair via `findBindingWithConnectionById` +
 * `buildContextFromBinding`; breaker/health mutations target the connection.
 *
 * Multi-env disambiguation in the inbound router is covered by
 * `inbound-routes.test.ts`; this test focuses on the adapter loop.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoolifyConfig, CoolifySecrets } from '../../src/integrations/coolify/types.js';
import { signHmacSha256 } from '../../src/webhooks/hmac.js';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Fixed test key so vault encrypt/decrypt is deterministic.
process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type StoreMod = typeof import('../../src/integrations/store.js');
type Mods = {
  coolifyAdapter: typeof import('../../src/integrations/coolify/adapter.js').coolifyAdapter;
  encryptJson: typeof import('../../src/integrations/vault.js').encryptJson;
  findConnectionById: StoreMod['findConnectionById'];
  findBindingWithConnectionById: StoreMod['findBindingWithConnectionById'];
  buildContextFromBinding: StoreMod['buildContextFromBinding'];
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
      findConnectionById: storeMod.findConnectionById,
      findBindingWithConnectionById: storeMod.findBindingWithConnectionById,
      buildContextFromBinding: storeMod.buildContextFromBinding,
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

    // Connection = the credential (active/breaker state + secrets + baseUrl).
    const connectionId = randomUUID();
    const secretsEnc = mods.encryptJson({ apiToken: 'test-token-abc-123' });
    await harness.db.execute(sql`
      INSERT INTO integration_connections
        (id, owner_type, owner_id, provider, config, secrets_enc, active)
      VALUES (
        ${connectionId},
        'user',
        ${owner.id},
        'coolify',
        ${JSON.stringify({ baseUrl: 'https://coolify.test' })}::jsonb,
        ${secretsEnc},
        true
      )
    `);

    // Binding = per-project+env link (config overrides + inbound HMAC secret).
    const bindingId = randomUUID();
    const integrationSecret = opts.secret ?? `whsec_test_${bindingId.slice(0, 12)}`;
    await harness.db.execute(sql`
      INSERT INTO integration_bindings
        (id, connection_id, project_id, provider, environment, config, integration_secret, active)
      VALUES (
        ${bindingId},
        ${connectionId},
        ${project.id},
        'coolify',
        ${opts.environment},
        ${JSON.stringify({
          resourceUuid: 'res-1',
          branch: 'main',
          environment: opts.environment,
        })}::jsonb,
        ${integrationSecret},
        true
      )
    `);

    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, NULL, 'system', 'completed', NOW())
    `);
    return { project, connectionId, bindingId, integrationSecret, runId };
  }

  it('outbound dispatch → records delivery with deployment_uuid', async () => {
    const seed = await seedIntegration({ environment: 'staging' });

    // Coolify v4 deploy returns a `deployments[]` array.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          deployments: [{ deployment_uuid: 'deploy-uuid-A', message: 'queued' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const pair = await mods.findBindingWithConnectionById(seed.bindingId);
    expect(pair).not.toBeNull();
    const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair!);
    const result = await mods.coolifyAdapter.dispatchOutbound(ctx, {
      eventName: 'release.requested',
      runId: seed.runId,
      payload: { runId: seed.runId, issueId: null, environment: 'staging' },
      requestId: `${seed.runId}:${seed.bindingId}`,
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
    const r = rows[0] as
      | { status: string; response: { deployment_uuid?: string } | null }
      | undefined;
    expect(r?.status).toBe('ok');
    expect(r?.response?.deployment_uuid).toBe('deploy-uuid-A');
  });

  it('inbound webhook with success status stamps the run', async () => {
    const seed = await seedIntegration({ environment: 'staging' });

    // First record an outbound that the inbound will be matched against.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ deployment_uuid: 'deploy-uuid-B' }), { status: 200 }),
    );
    const pair = await mods.findBindingWithConnectionById(seed.bindingId);
    const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair!);
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
    const pair = await mods.findBindingWithConnectionById(seed.bindingId);
    const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair!);

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

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    const pair = await mods.findBindingWithConnectionById(seed.bindingId);
    const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair!);

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

    // Breaker/active state lives on the CONNECTION (the credential), not the binding.
    const afterConnection = await mods.findConnectionById(seed.connectionId);
    expect(afterConnection?.active).toBe(false);
    expect(afterConnection?.breakerOpenedAt).not.toBeNull();
  });

  it('a tripped breaker blocks further outbound dispatch', async () => {
    const seed = await seedIntegration({ environment: 'staging' });
    await harness.db.execute(sql`
      UPDATE integration_connections SET active = false WHERE id = ${seed.connectionId}
    `);
    const pair = await mods.findBindingWithConnectionById(seed.bindingId);
    const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair!);

    await expect(
      mods.coolifyAdapter.dispatchOutbound(ctx, {
        eventName: 'release.requested',
        runId: seed.runId,
        payload: { runId: seed.runId, issueId: null, environment: 'staging' },
      }),
    ).rejects.toThrow(/inactive|circuit breaker/i);
  });
});
