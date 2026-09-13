/**
 * The body columns against real Postgres.
 *
 * The unit suite proves the validator; it cannot prove the migration. What only
 * a real database can answer: that `format` arrives NOT NULL with a
 * `'markdown'` default, so a row written by a caller — or by any of the ~17
 * kernel paths that still `db.insert(comments)` directly — renders exactly as
 * it did before html bodies existed. That default is the whole
 * backwards-compatibility story of ISS-898 (Decision 8, UC9), and a wrong
 * default is invisible until every historical comment renders as broken markup.
 *
 * `template`/`description_template` were dropped with the component vocabulary
 * on 2026-09-14, and the cases that held them went with it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MERMAID = 'flowchart LR\n  A["x"] --> B["y<br/>z"]';

describe('body format columns', () => {
  let harness: TestDatabase;
  let insertComment: typeof import('../../src/comments/service.js').insertComment;
  let schema: typeof import('../../src/db/schema.js');

  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ insertComment } = await import('../../src/comments/service.js'));
    schema = await import('../../src/db/schema.js');
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
  });

  async function anIssue(): Promise<string> {
    const id = randomUUID();
    await harness.db.insert(schema.issues).values({
      id,
      projectId,
      title: 'body format fixture',
      createdById: userId,
    });
    return id;
  }

  it('gives an insert that names no format the markdown default, NOT NULL', async () => {
    const issueId = await anIssue();
    const [row] = await harness.db
      .insert(schema.comments)
      .values({ issueId, authorId: userId, body: '**Triage** — complexity: m' })
      .returning({ format: schema.comments.format });

    expect(row?.format).toBe('markdown');

    const [issue] = await harness.db
      .select({
        format: schema.issues.descriptionFormat,
      })
      .from(schema.issues)
      .where(sql`${schema.issues.id} = ${issueId}`);
    expect(issue?.format).toBe('markdown');
  });

  it('rejects a format the column enum does not carry', async () => {
    const issueId = await anIssue();
    await expect(
      harness.db.execute(
        sql`INSERT INTO comments (issue_id, author_id, body, format)
            VALUES (${issueId}, ${userId}, 'x', 'rst')`,
      ),
    ).rejects.toThrow();
  });

  // cm:guard the round trip is asserted on a MARKDOWN fence now: a mermaid diagram was `<forge-diagram>` until the vocabulary was removed on 2026-09-14, and the fence is what the composer's own toolbar writes. What is being proved is unchanged — Postgres stores `-->` and `<br/>` byte-identically.
  it('round-trips a mermaid diagram through Postgres byte-identically', async () => {
    const issueId = await anIssue();
    const body = `\`\`\`mermaid\n${MERMAID}\n\`\`\``;
    const written = await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      authorAgency: 'human',
      body,
      format: 'markdown',
      parentId: null,
    });

    const [stored] = await harness.db
      .select({ body: schema.comments.body })
      .from(schema.comments)
      .where(sql`${schema.comments.id} = ${written.row.id}`);
    expect(stored?.body).toBe(body);
    expect(stored?.body).toContain('-->');
    expect(stored?.body).toContain('<br/>');
  });
});
