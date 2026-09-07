/**
 * ISS-963 — an attachment on an issue is one document with one name.
 *
 * Against real Postgres and real local-FS storage, because the rule IS a query:
 * the unit suite mocks `db.select`, so a mocked pass there proves the error is
 * constructed and nothing about whether the collision is found.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Refusal {
  code?: string;
  details?: { existing?: { id?: string; name?: string; url?: string } };
}

describe('attachment name identity', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let uploadsDir: string;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let createUploadTicket: typeof import('../../src/uploads/ticket-service.js').createUploadTicket;
  let persistSessionAttachment: typeof import('../../src/agent-sessions/attachment-service.js').persistSessionAttachment;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    uploadsDir = mkdtempSync(join(tmpdir(), 'iss963-uploads-'));
    process.env.DATABASE_URL = harness.url;
    process.env.UPLOADS_DIR = uploadsDir;
    process.env.STORAGE_DRIVER = 'local';
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

    const { issueAttachmentRoutes, attachmentRoutes } = await import(
      '../../src/issues/attachment-routes.js'
    );
    const { commentRoutes } = await import('../../src/comments/routes.js');
    const { uploadRoutes } = await import('../../src/uploads/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
    createUploadTicket = (await import('../../src/uploads/ticket-service.js')).createUploadTicket;
    persistSessionAttachment = (
      await import('../../src/agent-sessions/attachment-service.js')
    ).persistSessionAttachment;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/issues', issueAttachmentRoutes);
    app.route('/api/attachments', attachmentRoutes);
    app.route('/api/comments', commentRoutes);
    app.route('/api/uploads', uploadRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
    if (uploadsDir) rmSync(uploadsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'name-identity', ${owner.id})
      RETURNING id
    `);
    const issueId = (rows[0] as { id: string }).id;
    const token = await signUserToken(owner.id);
    return { owner, project, issueId, token };
  }

  async function newIssue(projectId: string, ownerId: string) {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${projectId}, 'second', ${ownerId})
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  async function newComment(issueId: string, authorId: string) {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO comments (issue_id, author_id, body)
      VALUES (${issueId}, ${authorId}, 'holder')
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  function upload(path: string, token: string, filename: string, bytes = PNG) {
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(bytes)], filename, { type: 'image/png' }));
    return app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    });
  }

  async function countAttachments(issueId: string, name: string) {
    const rows = await harness.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM issue_attachments
      WHERE issue_id = ${issueId} AND name = ${name}
    `);
    return Number((rows[0] as { n: string }).n);
  }

  it('accepts the first upload of a name and refuses the second with the first row id and url', async () => {
    const { issueId, token } = await seed();

    const first = await upload(`/api/issues/${issueId}/attachments`, token, 'evidence.md');
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; name: string };
    expect(created.name).toBe('evidence.md');

    const second = await upload(`/api/issues/${issueId}/attachments`, token, 'evidence.md');
    expect(second.status).toBe(400);
    const body = (await second.json()) as Refusal;
    expect(body.code).toBe('ATTACHMENT_NAME_TAKEN');
    expect(body.details?.existing?.id).toBe(created.id);
    expect(body.details?.existing?.url).toBe(`/api/attachments/${created.id}/download`);
    expect(body.details?.existing?.name).toBe('evidence.md');

    expect(await countAttachments(issueId, 'evidence.md')).toBe(1);
  });

  it('refuses on the SANITISED name, so "a b.md" collides with an attached "a_b.md"', async () => {
    const { issueId, token } = await seed();

    const first = await upload(`/api/issues/${issueId}/attachments`, token, 'a b.md');
    expect(first.status).toBe(201);
    expect(((await first.json()) as { name: string }).name).toBe('a_b.md');

    const second = await upload(`/api/issues/${issueId}/attachments`, token, 'a_b.md');
    expect(second.status).toBe(400);
    expect(((await second.json()) as Refusal).code).toBe('ATTACHMENT_NAME_TAKEN');
    expect(await countAttachments(issueId, 'a_b.md')).toBe(1);
  });

  it('writes no blob for the refused upload', async () => {
    const { issueId, token } = await seed();
    await upload(`/api/issues/${issueId}/attachments`, token, 'once.md');

    const { readdirSync } = await import('node:fs');
    const dir = join(uploadsDir, 'issues', issueId);
    const before = readdirSync(dir);
    expect(before).toHaveLength(1);

    const refused = await upload(`/api/issues/${issueId}/attachments`, token, 'once.md');
    expect(refused.status).toBe(400);
    expect(readdirSync(dir)).toEqual(before);
  });

  it('accepts the same name on a different issue', async () => {
    const { issueId, token, project, owner } = await seed();
    const other = await newIssue(project.id, owner.id);

    expect((await upload(`/api/issues/${issueId}/attachments`, token, 'shared.md')).status).toBe(
      201,
    );
    expect((await upload(`/api/issues/${other}/attachments`, token, 'shared.md')).status).toBe(201);
  });

  it('refuses at mint time, naming the existing id, before any bytes are streamed', async () => {
    const { issueId, token, owner } = await seed();
    await upload(`/api/issues/${issueId}/attachments`, token, 'gate.log.png');
    const listed = (await (
      await app.request(`/api/issues/${issueId}/attachments`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as Array<{ id: string; name: string }>;
    const existingId = listed[0]?.id;

    await expect(
      createUploadTicket({
        targetType: 'issue',
        targetId: issueId,
        uploaderId: owner.id,
        uploaderDeviceId: null,
        name: 'gate.log.png',
        mime: 'image/png',
      }),
    ).rejects.toThrow(existingId);
  });

  it('refuses the PUT when the name was taken between mint and upload', async () => {
    const { issueId, token, owner } = await seed();
    const ticket = await createUploadTicket({
      targetType: 'issue',
      targetId: issueId,
      uploaderId: owner.id,
      uploaderDeviceId: null,
      name: 'race.png',
      mime: 'image/png',
    });

    expect((await upload(`/api/issues/${issueId}/attachments`, token, 'race.png')).status).toBe(201);

    const put = await app.request(`/api/uploads/${ticket.id}`, {
      method: 'PUT',
      body: new Uint8Array(PNG),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as Refusal).code).toBe('ATTACHMENT_NAME_TAKEN');
    expect(await countAttachments(issueId, 'race.png')).toBe(1);
  });

  it('scopes comment attachments to the one comment', async () => {
    const { issueId, token, owner } = await seed();
    const a = await newComment(issueId, owner.id);
    const b = await newComment(issueId, owner.id);

    expect((await upload(`/api/comments/${a}/attachments`, token, 'out.png')).status).toBe(201);

    const dup = await upload(`/api/comments/${a}/attachments`, token, 'out.png');
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as Refusal).code).toBe('ATTACHMENT_NAME_TAKEN');

    expect((await upload(`/api/comments/${b}/attachments`, token, 'out.png')).status).toBe(201);
  });

  it('leaves agent-session attachments unguarded', async () => {
    const { owner, project, issueId } = await seed();
    const runRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO pipeline_runs (project_id, issue_id)
      VALUES (${project.id}, ${issueId}) RETURNING id
    `);
    const runId = (runRows[0] as { id: string }).id;
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO agent_sessions (project_id, pipeline_run_id, user_id, title, status)
      VALUES (${project.id}, ${runId}, ${owner.id}, 'session', 'running')
      RETURNING id
    `);
    const sessionId = (rows[0] as { id: string }).id;

    const args = {
      sessionId,
      name: 'twice.png',
      mime: 'image/png',
      bytes: PNG,
      uploaderId: owner.id,
      uploaderDeviceId: null,
    };
    const one = await persistSessionAttachment(args);
    const two = await persistSessionAttachment(args);
    expect(two.id).not.toBe(one.id);
    expect(two.name).toBe('twice.png');
  });

  it('lists an id, a name and a url for every attachment', async () => {
    const { issueId, token } = await seed();
    await upload(`/api/issues/${issueId}/attachments`, token, 'one.png');
    await upload(`/api/issues/${issueId}/attachments`, token, 'two.png');

    const res = await app.request(`/api/issues/${issueId}/attachments`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string; name: string; url: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(['one.png', 'two.png']);
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.url).toBe(`/api/attachments/${r.id}/download`);
    }
  });

  it('closes the loop: the refused id deletes, and the name is then free again', async () => {
    const { issueId, token } = await seed();
    await upload(`/api/issues/${issueId}/attachments`, token, 'retry.png');

    const refused = await upload(`/api/issues/${issueId}/attachments`, token, 'retry.png');
    const existing = ((await refused.json()) as Refusal).details?.existing;
    expect(existing?.id).toBeTruthy();

    const del = await app.request(`/api/attachments/${existing?.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);

    const retry = await upload(`/api/issues/${issueId}/attachments`, token, 'retry.png');
    expect(retry.status).toBe(201);
    expect(await countAttachments(issueId, 'retry.png')).toBe(1);
  });

  it('still refuses a name that only an OTHER issue lacks, and reports the oldest row', async () => {
    const { issueId, token } = await seed();
    await harness.db.execute(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size, created_at)
      SELECT ${issueId}, created_by_id, 'legacy.md', 'local:old', 'text/markdown', 4, now() - interval '2 days'
      FROM issues WHERE id = ${issueId}
    `);
    await harness.db.execute(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size, created_at)
      SELECT ${issueId}, created_by_id, 'legacy.md', 'local:new', 'text/markdown', 4, now()
      FROM issues WHERE id = ${issueId}
    `);
    const oldest = await harness.db.execute<{ id: string }>(sql`
      SELECT id FROM issue_attachments
      WHERE issue_id = ${issueId} AND name = 'legacy.md'
      ORDER BY created_at ASC LIMIT 1
    `);

    const refused = await upload(`/api/issues/${issueId}/attachments`, token, 'legacy.md');
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as Refusal;
    expect(body.details?.existing?.id).toBe((oldest[0] as { id: string }).id);
  });

  it('does not refuse a name the issue never had', async () => {
    const { issueId, token } = await seed();
    expect(randomUUID()).toBeTruthy();
    expect((await upload(`/api/issues/${issueId}/attachments`, token, 'fresh.png')).status).toBe(
      201,
    );
  });
});
