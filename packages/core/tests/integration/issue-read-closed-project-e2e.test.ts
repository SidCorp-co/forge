import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// ISS-1229 r41 (judge-115, criterion 395): an issue of a project the reader holds no role on, read under the
// address of a project they belong to, is refused naming the issue's project as far as the reader may see it
// and saying the address's project is not the issue's — never "Not a project member." alone.

describe('GET /api/issues/:id — the refusal names the project', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const { issueRoutes } = await import('../../src/issues/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/issues', issueRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function issueIn(projectId: string, createdBy: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, 'Invoice footer shows last year', 'draft', 'low', ${createdBy})
    `);
    return id;
  }

  /** An org holding Desk (the reader's) and Vault (not theirs), and Elsewhere in an org the reader is not in. */
  async function seed({ readerInOrg }: { readerInOrg: boolean }) {
    const owner = await verifiedUser();
    const reader = await verifiedUser();
    const desk = await createTestProject(harness.db, owner.id, { name: 'R41 desk' });
    const vault = await createTestProject(harness.db, owner.id, {
      name: 'R41 vault',
      orgId: desk.orgId,
    });
    const stranger = await verifiedUser();
    const elsewhere = await createTestProject(harness.db, stranger.id, { name: 'Elsewhere' });
    if (readerInOrg)
      await createTestOrgMember(harness.db, { orgId: desk.orgId, userId: reader.id });
    await createTestProjectMember(harness.db, {
      userId: reader.id,
      projectId: desk.id,
      role: 'member',
    });
    return { owner, reader, desk, vault, elsewhere, vaultIssue: await issueIn(vault.id, owner.id) };
  }

  async function read(path: string, userId: string) {
    const res = await app.request(path, {
      headers: { Authorization: `Bearer ${await signUserToken(userId)}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("names the issue's project and the address's to a member of their organization", async () => {
    const s = await seed({ readerInOrg: true });

    const r = await read(`/api/issues/${s.vaultIssue}?projectId=${s.desk.id}`, s.reader.id);

    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      code: 'FORBIDDEN',
      message:
        'This issue belongs to R41 vault, a project you are not a member of. It is not in R41 desk, the project this address names.',
      details: {
        issueProject: { name: 'R41 vault' },
        addressProject: { id: s.desk.id, name: 'R41 desk' },
      },
    });
  });

  it("keeps the issue's project unnamed to a reader outside its organization", async () => {
    const s = await seed({ readerInOrg: false });

    const r = await read(`/api/issues/${s.vaultIssue}?projectId=${s.desk.id}`, s.reader.id);

    expect(r.status).toBe(403);
    expect(r.body.message).toBe(
      'This issue belongs to a project you are not a member of. It is not in R41 desk, the project this address names.',
    );
    expect(JSON.stringify(r.body)).not.toContain('R41 vault');
  });

  it('never names an address project the reader may not see', async () => {
    const s = await seed({ readerInOrg: true });

    const r = await read(`/api/issues/${s.vaultIssue}?projectId=${s.elsewhere.id}`, s.reader.id);

    expect(r.status).toBe(403);
    expect(r.body.message).toBe(
      'This issue belongs to R41 vault, a project you are not a member of. It is not in the project this address names.',
    );
    expect(JSON.stringify(r.body)).not.toContain('Elsewhere');
    expect(r.body.details).toEqual({
      issueProject: { name: 'R41 vault' },
      addressProject: { id: s.elsewhere.id, name: null },
    });
  });

  it('still answers an issue the reader may read, whatever project the address names', async () => {
    const s = await seed({ readerInOrg: true });
    const deskIssue = await issueIn(s.desk.id, s.owner.id);

    const r = await read(`/api/issues/${deskIssue}?projectId=${s.vault.id}`, s.reader.id);

    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(s.desk.id);
  });
});
