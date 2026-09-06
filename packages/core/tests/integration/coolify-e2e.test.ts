/**
 * ISS-234 — Coolify deploy integration E2E, against real Postgres.
 *
 *   1. dispatchOutbound posts to Coolify (fetch mocked) and writes an
 *      `integration_deliveries` row carrying the deployment_uuid.
 *   2. ISS-922 — the deploy's CONFIRMATION HOLD lands on the run's metadata by
 *      a real `jsonb_set` on a real jsonb column, and is refused on a run that
 *      already went terminal. The gate that reads these holds is proved in
 *      `pipeline/deploy-confirmations.test.ts`; the inbound router no longer
 *      routes coolify at all.
 *   3. Repeated outbound failures inside the breaker window flip the owning
 *      `integration_connections.active=false`.
 *
 * The credential lives on `integration_connections` and the per-project+env
 * config on `integration_bindings` (ISS-410); the adapter pairs them through
 * `findBindingWithConnectionById` + `buildContextFromBinding`, and
 * breaker/health mutations target the connection.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoolifyConfig, CoolifySecrets } from '../../src/integrations/coolify/types.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why the adapter enqueues a confirmation poll per target and pg-boss is not part of what this suite proves, so the send is a spy.
vi.mock('../../src/integrations/coolify/confirm.js', () => ({
  enqueueCoolifyConfirm: vi.fn(),
}));

// Fixed test key so vault encrypt/decrypt is deterministic.
process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type StoreMod = typeof import('../../src/integrations/store.js');
type HoldsMod = typeof import('../../src/pipeline/deploy-confirmations.js');
type Mods = {
  coolifyAdapter: typeof import('../../src/integrations/coolify/adapter.js').coolifyAdapter;
  encryptJson: typeof import('../../src/integrations/vault.js').encryptJson;
  findConnectionById: StoreMod['findConnectionById'];
  findBindingWithConnectionById: StoreMod['findBindingWithConnectionById'];
  buildContextFromBinding: StoreMod['buildContextFromBinding'];
  resolveDeployGate: HoldsMod['resolveDeployGate'];
  settleDeployTarget: HoldsMod['settleDeployTarget'];
  markCloseDeferred: HoldsMod['markCloseDeferred'];
  isCloseDeferred: HoldsMod['isCloseDeferred'];
};

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
  const holdsMod = await import('../../src/pipeline/deploy-confirmations.js');
  mods = {
    resolveDeployGate: holdsMod.resolveDeployGate,
    settleDeployTarget: holdsMod.settleDeployTarget,
    markCloseDeferred: holdsMod.markCloseDeferred,
    isCloseDeferred: holdsMod.isCloseDeferred,
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
  runStatus?: 'running' | 'completed';
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
        // ISS-558 multi-target shape: the adapter fans out one deploy per
        // targets[] entry; a binding without targets refuses to dispatch.
        targets: [{ id: 't-1', label: 'App', resourceUuid: 'res-1' }],
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
    VALUES (${runId}, ${project.id}, NULL, 'system', ${opts.runStatus ?? 'completed'}, NOW())
  `);
  return { project, connectionId, bindingId, integrationSecret, runId };
}

async function dispatchOnce(
  seed: Awaited<ReturnType<typeof seedIntegration>>,
  deploymentUuid: string,
) {
  vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ deployment_uuid: deploymentUuid }), { status: 200 }),
  );
  const pair = await mods.findBindingWithConnectionById(seed.bindingId);
  if (!pair) throw new Error('seedIntegration produced no binding+connection pair');
  const ctx = mods.buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair);
  return mods.coolifyAdapter.dispatchOutbound(ctx, {
    eventName: 'release.requested',
    runId: seed.runId,
    payload: { runId: seed.runId, issueId: null, environment: 'staging' },
    requestId: `${seed.runId}:${seed.bindingId}`,
  });
}

async function readHolds(runId: string) {
  const rows = await harness.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM pipeline_runs WHERE id = ${runId}
  `);
  const metadata = (rows[0] as { metadata: Record<string, unknown> } | undefined)?.metadata;
  return metadata?.__forge_deploy_confirm as
    | Parameters<typeof mods.resolveDeployGate>[0]
    | undefined;
}

describe('ISS-234 — coolify deploy dispatch and its breaker', () => {
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

describe('ISS-922 — the deploy a run has to prove before it may close', () => {
  it('records one confirmation hold per target on the run, against real jsonb', async () => {
    const seed = await seedIntegration({ environment: 'staging', runStatus: 'running' });
    await dispatchOnce(seed, 'deploy-uuid-B');

    const holds = await readHolds(seed.runId);
    expect(Object.values(holds ?? {})).toEqual([
      expect.objectContaining({ deploymentUuid: 'deploy-uuid-B', status: 'pending' }),
    ]);
    expect(mods.resolveDeployGate(holds ?? {}).verdict).toBe('defer');
  });

  it('refuses the hold on a run that already went terminal — a closed run cannot witness a deploy', async () => {
    const seed = await seedIntegration({ environment: 'staging', runStatus: 'completed' });
    await dispatchOnce(seed, 'deploy-uuid-C');

    expect(await readHolds(seed.runId)).toBeUndefined();
  });

  it('a settled hold and a deferred close survive a real jsonb round trip', async () => {
    const seed = await seedIntegration({ environment: 'staging', runStatus: 'running' });
    const res = await dispatchOnce(seed, 'deploy-uuid-D');

    await mods.markCloseDeferred(seed.runId);
    expect(await mods.isCloseDeferred(seed.runId)).toBe(true);

    const after = await mods.settleDeployTarget({
      runId: seed.runId,
      deliveryId: res.deliveryId,
      status: 'succeeded',
    });
    expect(mods.resolveDeployGate(after).verdict).toBe('clear');

    // cm:guard the deferral marker and the holds are siblings under ONE jsonb column, so a write to either that rebuilds the whole map erases the other — this assertion is the only thing that catches it.
    expect(await mods.isCloseDeferred(seed.runId)).toBe(true);
    expect(Object.values(after)).toHaveLength(1);
  });

  it('handleInbound refuses by name rather than accepting a body Coolify never signed', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: the refusal takes no meaningful args
      (mods.coolifyAdapter as any).handleInbound(),
    ).rejects.toThrow(/inbound webhooks are not supported/);
  });
});
