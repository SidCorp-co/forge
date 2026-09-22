/**
 * ISS-1140 — a call turned away at the inbound door leaves a record that it arrived.
 *
 * `POST /api/webhooks/in/:slug` refused a missing or invalid signature correctly and recorded
 * nothing, so from inside Forge "the provider never called" and "a call reached us and we turned
 * it away" read identically: zero deliveries either way. A wrong or rotated webhook secret was
 * unfalsifiable. These are the database halves of that fix — what counts as a delivery, what a
 * turn-away record holds, and what stops the unauthenticated door being a place to put bytes.
 */

import { createHmac, randomUUID } from 'node:crypto';
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
// biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
let readInboundDoorTraffic: typeof import('../../src/integrations/inbound-door.js').readInboundDoorTraffic;
// biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
let recordTurnedAwayInboundCall: typeof import('../../src/integrations/inbound-door.js').recordTurnedAwayInboundCall;

const SECRET = 'the-binding-signing-secret-at-least-32-chars';

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

  const [routes, errMod, door] = await Promise.all([
    import('../../src/webhooks/inbound-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/integrations/inbound-door.js'),
  ]);
  readInboundDoorTraffic = door.readInboundDoorTraffic;
  recordTurnedAwayInboundCall = door.recordTurnedAwayInboundCall;
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();

  app = new Hono<{ Variables: RequestIdVars }>();
  app.route('/api/webhooks', routes.webhookInboundRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let projectSlug: string;
let bindingId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  projectSlug = project.slug;
  const connectionId = randomUUID();
  bindingId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${user.id}::uuid, 'github', '{}'::jsonb, NULL, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (id, connection_id, project_id, provider, role, stages, config, active, integration_secret)
    VALUES (${bindingId}, ${connectionId}, ${project.id}::uuid, 'github', 'service',
            ARRAY[]::text[], '{}'::jsonb, true, ${SECRET})
  `);
});

const body = JSON.stringify({ action: 'opened', repository: { full_name: 'SidCorp-co/forge' } });
const sign = (secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const knock = (headers: Record<string, string>) =>
  app.request(`/api/webhooks/in/${projectSlug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', ...headers },
    body,
  });

async function deliveries() {
  return (await harness.db.execute(sql`
    SELECT status, direction, event_name, error_message, payload, request_id
    FROM integration_deliveries WHERE binding_id = ${bindingId}::uuid
    ORDER BY created_at
  `)) as unknown as Array<{
    status: string;
    direction: string;
    event_name: string;
    error_message: string | null;
    payload: unknown;
    request_id: string | null;
  }>;
}

describe('a call turned away at the door', () => {
  // Criterion 6. The refusal is still the deliverable; the record is what makes it visible.
  it('is recorded with its refusal code when the signature does not verify', async () => {
    const res = await knock({ 'x-hub-signature-256': sign('a-completely-different-secret!!!') });
    expect(res.status).toBe(401);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'refused',
      direction: 'inbound',
      event_name: 'inbound.refused',
      error_message: 'INVALID_SIGNATURE',
    });
  });

  it('is recorded when no signature arrives at all, under its own code', async () => {
    expect((await knock({})).status).toBe(401);
    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error_message).toBe('MISSING_SIGNATURE');
  });

  // Criterion 7. The door is unauthenticated, so the body is whatever anyone sent.
  it('holds none of the request body', async () => {
    await knock({ 'x-hub-signature-256': sign('wrong') });
    const rows = await deliveries();
    expect(rows[0]?.payload).toEqual({});
    expect(JSON.stringify(rows[0])).not.toContain('SidCorp-co/forge');
  });

  // Criterion 8. Without this the door is a write amplifier for anyone who knows a project slug.
  it('leaves one record for a flood of the same refusal in one bucket', async () => {
    for (let i = 0; i < 6; i++) await knock({ 'x-hub-signature-256': sign('wrong') });
    expect(await deliveries()).toHaveLength(1);
  });

  it('keeps a different refusal code apart rather than folding it into the first', async () => {
    await knock({ 'x-hub-signature-256': sign('wrong') });
    await knock({});
    const codes = (await deliveries()).map((r) => r.error_message).sort();
    expect(codes).toEqual(['INVALID_SIGNATURE', 'MISSING_SIGNATURE']);
  });

  // Review finding on this head: the record is best-effort and the REFUSAL is the deliverable, so
  // a write that cannot land must not turn a 401 into a 500. Planted by making the insert itself
  // impossible, which is the only way to watch that branch run.
  it('still answers 401 when the record cannot be written at all', async () => {
    await harness.db.execute(sql`
      ALTER TABLE integration_deliveries
      ADD CONSTRAINT tmp_no_refusals CHECK (status <> 'refused')
    `);
    try {
      const res = await knock({ 'x-hub-signature-256': sign('wrong') });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe('INVALID_SIGNATURE');
      expect(await deliveries()).toHaveLength(0);
    } finally {
      await harness.db.execute(
        sql`ALTER TABLE integration_deliveries DROP CONSTRAINT tmp_no_refusals`,
      );
    }
  });

  // The bucket is fixed, not rolling: the next one takes its own record.
  it('records again in the next bucket, so a door that stays refused keeps saying so', async () => {
    const at = new Date('2026-09-21T09:00:00.000Z');
    await recordTurnedAwayInboundCall({ bindingId, code: 'INVALID_SIGNATURE', eventName: 'x', at });
    await recordTurnedAwayInboundCall({
      bindingId,
      code: 'INVALID_SIGNATURE',
      eventName: 'x',
      at: new Date(at.getTime() + 11 * 60_000),
    });
    expect(await deliveries()).toHaveLength(2);
  });
});

describe('what the door reading counts', () => {
  // Criterion 9. A refusal that counted as a delivery would say the door had opened, which is the
  // same false green the whole change exists to refuse, wearing a new cause.
  it('counts a turn-away as turned away and never as a delivery', async () => {
    await knock({ 'x-hub-signature-256': sign('wrong') });
    const traffic = await readInboundDoorTraffic(bindingId);
    expect(traffic.accepted).toBe(0);
    expect(traffic.lastAcceptedAt).toBeNull();
    expect(traffic.refusalRecords).toBe(1);
    expect(traffic.lastRefusalCode).toBe('INVALID_SIGNATURE');
    expect(traffic.lastRecordedRefusalAt).toBeInstanceOf(Date);
  });

  it('counts a delivery that got in, beside the refusals, without either hiding the other', async () => {
    await harness.db.execute(sql`
      INSERT INTO integration_deliveries (binding_id, direction, event_name, status, payload)
      VALUES (${bindingId}::uuid, 'inbound', 'pull_request.opened', 'ok', '{}'::jsonb)
    `);
    await knock({ 'x-hub-signature-256': sign('wrong') });

    const traffic = await readInboundDoorTraffic(bindingId);
    expect(traffic.accepted).toBe(1);
    expect(traffic.refusalRecords).toBe(1);
  });

  it('answers a door nothing has reached with zeroes rather than with nulls that read as unknown', async () => {
    await expect(readInboundDoorTraffic(bindingId)).resolves.toEqual({
      accepted: 0,
      lastAcceptedAt: null,
      refusalRecords: 0,
      lastRecordedRefusalAt: null,
      lastRefusalCode: null,
    });
  });
});
