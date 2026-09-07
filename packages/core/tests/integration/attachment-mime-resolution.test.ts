/**
 * ISS-957 — the bytes decide the stored type, and a refusal names the set.
 *
 * Against real Postgres and real local-FS storage. The unit suite mocks the
 * storage driver and `db.insert`, so a green there proves the resolution
 * function returns the right string and nothing about what column value the
 * row ends up holding, nor whether a refused batch leaves the issue clean.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

const PLAIN_LOG = Buffer.from('vitest run\n480 files, 5574 tests, 0 failures\n');
const BINARY_LOG = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x89, 0x50, 0x4e, 0x47]);
const REAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG_SOURCE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

interface Refusal {
  code?: string;
  message?: string;
  details?: {
    reason?: string;
    allowed?: { mimes?: string[]; extensions?: string[]; anyExtensionIfText?: boolean };
  };
}

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let uploadsDir: string;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let persistIssueAttachmentsFromBase64: typeof import('../../src/issues/attachment-service.js').persistIssueAttachmentsFromBase64;

beforeAll(async () => {
  harness = await setupTestDatabase();
  uploadsDir = mkdtempSync(join(tmpdir(), 'iss957-uploads-'));
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
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  persistIssueAttachmentsFromBase64 = (await import('../../src/issues/attachment-service.js'))
    .persistIssueAttachmentsFromBase64;

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issues', issueAttachmentRoutes);
  app.route('/api/attachments', attachmentRoutes);
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
    VALUES (${project.id}, 'mime-resolution', ${owner.id})
    RETURNING id
  `);
  const issueId = (rows[0] as { id: string }).id;
  return { owner, project, issueId, token: await signUserToken(owner.id) };
}

function upload(issueId: string, token: string, filename: string, bytes: Buffer, type = '') {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(bytes)], filename, { type }));
  return app.request(`/api/issues/${issueId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
}

async function storedMime(issueId: string, name: string) {
  const rows = await harness.db.execute<{ mime: string }>(sql`
    SELECT mime FROM issue_attachments WHERE issue_id = ${issueId} AND name = ${name}
  `);
  return rows[0] ? (rows[0] as { mime: string }).mime : null;
}

// cm:guard scope every blob assertion to THIS issue's directory — `uploadsDir` is made once in beforeAll and `truncateAll` clears the DB but never the filesystem, so a bare read of `issues/` counts directories every earlier test in the file left behind
function blobsFor(issueId: string): string[] {
  try {
    return readdirSync(join(uploadsDir, 'issues', issueId));
  } catch {
    return [];
  }
}

async function countAttachments(issueId: string) {
  const rows = await harness.db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM issue_attachments WHERE issue_id = ${issueId}
  `);
  return Number((rows[0] as { n: string }).n);
}

describe('attachment type resolution — the bytes decide', () => {
  it('stores a plain-text .log as text/plain, an extension the table has never held', async () => {
    const { issueId, token } = await seed();

    const res = await upload(issueId, token, 'gate.log', PLAIN_LOG);

    expect(res.status).toBe(201);
    expect(await storedMime(issueId, 'gate.log')).toBe('text/plain');
  });

  it('stores a plain-text .sql as text/plain', async () => {
    const { issueId, token } = await seed();

    expect(
      (await upload(issueId, token, 'schema.sql', Buffer.from('ALTER TABLE issues;\n'))).status,
    ).toBe(201);
    expect(await storedMime(issueId, 'schema.sql')).toBe('text/plain');
  });

  it('stores plain text under an extension nothing maps at all', async () => {
    const { issueId, token } = await seed();

    expect((await upload(issueId, token, 'trace.wibble', PLAIN_LOG)).status).toBe(201);
    expect(await storedMime(issueId, 'trace.wibble')).toBe('text/plain');
  });

  it('keeps a real PNG as image/png', async () => {
    const { issueId, token } = await seed();

    expect((await upload(issueId, token, 'shot.png', REAL_PNG, 'image/png')).status).toBe(201);
    expect(await storedMime(issueId, 'shot.png')).toBe('image/png');
  });

  it('keeps SVG source as image/svg+xml, because SVG is itself UTF-8 text', async () => {
    const { issueId, token } = await seed();

    expect((await upload(issueId, token, 'logo.svg', SVG_SOURCE, 'image/svg+xml')).status).toBe(
      201,
    );
    expect(await storedMime(issueId, 'logo.svg')).toBe('image/svg+xml');
  });

  it('narrows by extension among the text types: a .md of text is text/markdown', async () => {
    const { issueId, token } = await seed();

    expect((await upload(issueId, token, 'notes.md', Buffer.from('# hi\n'))).status).toBe(201);
    expect(await storedMime(issueId, 'notes.md')).toBe('text/markdown');
  });
});

describe('attachment type resolution — a refusal names the set it enforces', () => {
  it('refuses a .log whose bytes are binary, and says the bytes are why', async () => {
    const { issueId, token } = await seed();

    const res = await upload(issueId, token, 'core.log', BINARY_LOG, 'text/plain');

    expect(res.status).toBe(400);
    const body = (await res.json()) as Refusal;
    expect(body.code).toBe('MIME_NOT_ALLOWED');
    expect(body.details?.reason).toBe('not-text');
    expect(body.message).toContain('the bytes are binary');
    expect(await countAttachments(issueId)).toBe(0);
  });

  it('carries the whole allowed set — types and extensions — in the refusal body', async () => {
    const { issueId, token } = await seed();

    const res = await upload(issueId, token, 'evil.exe', BINARY_LOG, 'application/x-msdownload');

    expect(res.status).toBe(400);
    const body = (await res.json()) as Refusal;
    expect(body.details?.reason).toBe('not-allowed');
    expect(body.details?.allowed?.mimes).toEqual(
      expect.arrayContaining(['text/plain', 'image/png', 'video/mp4']),
    );
    expect(body.details?.allowed?.extensions).toEqual(
      expect.arrayContaining(['.txt', '.png', '.csv']),
    );
    expect(body.details?.allowed?.anyExtensionIfText).toBe(true);
  });

  it('writes no blob for a refused upload', async () => {
    const { issueId, token } = await seed();
    await upload(issueId, token, 'core.log', BINARY_LOG, 'text/plain');

    expect(blobsFor(issueId)).toEqual([]);
  });
});

describe('attachment batches land whole or not at all', () => {
  it('leaves the issue exactly as it was when one member of a batch is binary', async () => {
    const { issueId, owner } = await seed();

    const result = await persistIssueAttachmentsFromBase64(
      issueId,
      [
        { name: 'good.png', mime: 'image/png', dataBase64: REAL_PNG.toString('base64') },
        { name: 'core.log', mime: 'text/plain', dataBase64: BINARY_LOG.toString('base64') },
        {
          name: 'notes.md',
          mime: 'text/markdown',
          dataBase64: Buffer.from('# hi\n').toString('base64'),
        },
      ],
      owner.id,
      'human',
    );

    expect(result.persisted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.code).toBe('MIME_NOT_ALLOWED');
    expect(await countAttachments(issueId)).toBe(0);
    expect(blobsFor(issueId)).toEqual([]);
  });

  it('refuses a batch carrying one name twice without landing either copy', async () => {
    const { issueId, owner } = await seed();

    const result = await persistIssueAttachmentsFromBase64(
      issueId,
      [
        { name: 'gate.log', mime: '', dataBase64: PLAIN_LOG.toString('base64') },
        { name: 'gate.log', mime: '', dataBase64: Buffer.from('second\n').toString('base64') },
      ],
      owner.id,
      'human',
    );

    expect(result.persisted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.code).toBe('ATTACHMENT_NAME_TAKEN');
    // cm:guard this is the load-bearing assertion, not the count: without the pre-flight the batch still ends empty, but member 2 collides with member 1, the rollback deletes it, and the refusal cites an `existing` row id that no longer resolves (ISS-957)
    expect(result.errors[0]?.details).toEqual({ duplicateWithinBatch: 'gate.log' });
    expect(await countAttachments(issueId)).toBe(0);
    expect(blobsFor(issueId)).toEqual([]);
  });

  it('persists every member of a batch that passes, resolving each type from its own bytes', async () => {
    const { issueId, owner } = await seed();

    const result = await persistIssueAttachmentsFromBase64(
      issueId,
      [
        { name: 'good.png', mime: 'image/png', dataBase64: REAL_PNG.toString('base64') },
        { name: 'gate.log', mime: '', dataBase64: PLAIN_LOG.toString('base64') },
      ],
      owner.id,
      'human',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.persisted).toHaveLength(2);
    expect(await storedMime(issueId, 'good.png')).toBe('image/png');
    expect(await storedMime(issueId, 'gate.log')).toBe('text/plain');
  });
});
