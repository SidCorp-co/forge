import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestDevice,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  type TestUser,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-946 — `GET /api/admin/mcp-audit/tools` against real Postgres.
 *
 * Every clause this route exists for is SQL behaviour, and a mocked db proves
 * none of it. The three shapes it is most likely to get wrong are the three
 * that have already deleted live tools or hidden dead ones: splitting on
 * `user_id` (which is stamped for a device caller too, so it reads 100% user),
 * an inner join that drops the never-called tools the rule is hunting, and a
 * query for the dotted spelling that finds none of the underscore rows agents
 * actually send.
 */
describe('admin MCP audit tool counts (ISS-946)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let admin: TestUser;
  let outsider: TestUser;

  const ADMIN_EMAIL = 'admin@test.forge.local';

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
    // cm:guard `env.ts` freezes `env` at first import, so ADMIN_EMAILS must be set BEFORE the dynamic import below or requireAdmin sees an empty allow-list and every case 403s
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { adminMcpAuditRoutes } = await import('../../src/admin/mcp-audit-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminMcpAuditRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    admin = await createTestUser(harness.db, { email: ADMIN_EMAIL, emailVerifiedAt: new Date() });
    outsider = await createTestUser(harness.db, {
      email: 'nobody@test.forge.local',
      emailVerifiedAt: new Date(),
    });
  });

  async function get(token: string) {
    return app.request('/api/admin/mcp-audit/tools', {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function asAdmin() {
    const res = await get(await signUserToken(admin.id));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      generatedAt: string;
      oldestRow: string | null;
      registeredCount: number;
      rows: Array<{
        tool: string;
        registered: boolean;
        deviceCalls: number;
        tokenCalls: number;
        unattributedCalls: number;
        notFoundCalls: number;
        totalCalls: number;
        firstSeen: string | null;
        lastSeen: string | null;
      }>;
    };
  }

  const row = (
    body: Awaited<ReturnType<typeof asAdmin>>,
    tool: string,
  ): NonNullable<Awaited<ReturnType<typeof asAdmin>>['rows'][number]> => {
    const found = body.rows.find((r) => r.tool === tool);
    if (!found) throw new Error(`no row for ${tool}; got ${body.rows.length} rows`);
    return found;
  };

  /** A PAT row, for the only column the token half of the split may read. */
  async function makeToken(userId: string, name: string): Promise<string> {
    const [created] = (await harness.db.execute(sql`
      INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix)
      VALUES (${userId}, ${name}, ${`hash-${name}`}, ${`forge_pat_test_${name.slice(0, 2)}`})
      RETURNING id
    `)) as unknown as Array<{ id: string } | undefined>;
    if (!created) throw new Error(`no personal_access_tokens row came back for ${name}`);
    return created.id;
  }

  async function audit(opts: {
    tool: string;
    userId?: string | null;
    tokenId?: string | null;
    deviceId?: string | null;
    resultCode?: string;
    createdAt?: Date;
  }): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO mcp_audit_log (user_id, token_id, device_id, tool, result_code, created_at)
      VALUES (${opts.userId ?? null}, ${opts.tokenId ?? null}, ${opts.deviceId ?? null},
              ${opts.tool}, ${opts.resultCode ?? 'ok'},
              ${(opts.createdAt ?? new Date()).toISOString()})
    `);
  }

  describe('authorisation', () => {
    it('refuses a signed-in non-admin with 403 ADMIN_ONLY', async () => {
      const res = await get(await signUserToken(outsider.id));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('ADMIN_ONLY');
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await app.request('/api/admin/mcp-audit/tools');
      expect(res.status).toBe(401);
    });
  });

  describe('the credential split', () => {
    it('counts device and token callers on their own columns', async () => {
      const device = await createTestDevice(harness.db, admin.id);
      const tokenId = await makeToken(admin.id, 'cli');
      await audit({ tool: 'forge_issues', deviceId: device.id, userId: admin.id });
      await audit({ tool: 'forge_issues', deviceId: device.id, userId: admin.id });
      await audit({ tool: 'forge_issues', tokenId, userId: admin.id });

      const r = row(await asAdmin(), 'forge_issues');
      expect(r.deviceCalls).toBe(2);
      expect(r.tokenCalls).toBe(1);
      expect(r.totalCalls).toBe(3);
    });

    // cm:guard THE regression case for `7f0c5a56`, which deleted six live tools: a device call stamps `user_id` = `device.ownerId` as well, so a split that reads `user_id` sees every call as a user call and reports 0 devices. If this ever passes while the query groups on `user_id`, the assertion has stopped testing anything.
    it('does not read a device call as a token call, though both stamp user_id', async () => {
      const device = await createTestDevice(harness.db, admin.id);
      await audit({ tool: 'forge_skill_facts.get', deviceId: device.id, userId: admin.id });

      const r = row(await asAdmin(), 'forge_skill_facts.get');
      expect(r.deviceCalls).toBe(1);
      expect(r.tokenCalls).toBe(0);
      expect(r.unattributedCalls).toBe(0);
    });

    // cm:guard the `deviceCalls` assertion here is what discriminates `device_id` from `user_id`, and the case above cannot: a device row stamps BOTH, so any split that reads `user_id` still answers 1 there. This row stamps `user_id` and NEITHER id, so it is the only shape where the two columns disagree — a split on `user_id` reads it as a device call and goes red exactly here.
    it('counts a row carrying neither id as unattributed rather than dropping it', async () => {
      await audit({ tool: 'forge_health', userId: admin.id });

      const r = row(await asAdmin(), 'forge_health');
      expect(r.unattributedCalls).toBe(1);
      expect(r.totalCalls).toBe(1);
      expect(r.deviceCalls).toBe(0);
      expect(r.tokenCalls).toBe(0);
    });
  });

  describe('the spelling normalisation', () => {
    // cm:guard the underscore form is what agents actually send — the MCP client shows them `forge_memory_search`, not `forge_memory.search` — and every one of those rows lands as `not_found`. A query for the dotted name alone finds none of them, which is how three tools were read as never-called.
    it('folds the underscore spelling onto the registry’s dotted name', async () => {
      const tokenId = await makeToken(admin.id, 'agent');
      await audit({ tool: 'forge_memory_search', tokenId, resultCode: 'not_found' });
      await audit({ tool: 'forge_memory.search', tokenId });

      const body = await asAdmin();
      const r = row(body, 'forge_memory.search');
      expect(r.totalCalls).toBe(2);
      expect(r.notFoundCalls).toBe(1);
      expect(r.registered).toBe(true);
      expect(body.rows.filter((x) => x.tool === 'forge_memory_search')).toEqual([]);
    });
  });

  describe('the join runs in both directions', () => {
    // cm:guard a tool nothing has EVER called has no row in `mcp_audit_log`, so an inner join drops precisely the tools the deletion rule is looking for. `forge_memory.revisions` sat at zero rows lifetime and was invisible to the wave-3 query, which then reported "no candidates".
    it('returns every registered tool, including the ones with no rows at all', async () => {
      const body = await asAdmin();
      expect(body.rows.length).toBeGreaterThanOrEqual(body.registeredCount);
      const never = row(body, 'forge_health');
      expect(never.totalCalls).toBe(0);
      expect(never.registered).toBe(true);
      expect(never.lastSeen).toBeNull();
      expect(body.rows.filter((r) => r.registered)).toHaveLength(body.registeredCount);
    });

    it('returns a called name that is NOT registered, so a misspelling is visible', async () => {
      const tokenId = await makeToken(admin.id, 'stale');
      await audit({ tool: 'forge_metrics.step_durations', tokenId, resultCode: 'not_found' });

      const r = row(await asAdmin(), 'forge_metrics_step_durations');
      expect(r.registered).toBe(false);
      expect(r.notFoundCalls).toBe(1);
      expect(r.tokenCalls).toBe(1);
    });
  });

  describe('what the numbers mean', () => {
    // cm:guard `oldestRow` is the only thing that lets a reader decide whether these are LIFETIME counts. `agent-surface.md`'s "whole table" clause holds only while `enforceMcpAuditRetention` stays unwired; when someone wires it, this field is what shows a 90-day floor instead of a claim in prose going quietly stale.
    it('reports the oldest row, so a reader can judge the window for themselves', async () => {
      const tokenId = await makeToken(admin.id, 'old');
      const oldest = new Date('2026-01-02T03:04:05.000Z');
      await audit({ tool: 'forge_issues', tokenId, createdAt: oldest });
      await audit({ tool: 'forge_issues', tokenId, createdAt: new Date('2026-06-01T00:00:00Z') });

      const body = await asAdmin();
      expect(body.oldestRow).toBe(oldest.toISOString());
      expect(row(body, 'forge_issues').firstSeen).toBe(oldest.toISOString());
      expect(row(body, 'forge_issues').totalCalls).toBe(2);
    });

    it('reports oldestRow as null on an empty table rather than inventing a window', async () => {
      expect((await asAdmin()).oldestRow).toBeNull();
    });
  });
});
