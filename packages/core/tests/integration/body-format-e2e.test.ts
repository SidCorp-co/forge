/**
 * The body columns against real Postgres.
 *
 * The unit suite proves the validator; it cannot prove the migration. What only
 * a real database can answer: that `format` arrives NOT NULL with a
 * `'markdown'` default, so a row written by a caller — or by any of the ~17
 * kernel paths that still `db.insert(comments)` directly — renders exactly as
 * it did before component bodies existed. That default is the whole
 * backwards-compatibility story of ISS-898 (Decision 8, UC9), and a wrong
 * default is invisible until every historical comment renders as broken markup.
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

const REVIEW_BODY =
  '<forge-review sha="60e8d635" verdict="request-changes">' +
  '<forge-finding file="packages/core/src/pipeline/runs-cascade.ts" line="42" severity="bug">' +
  'The cascade skips a held job.</forge-finding>' +
  '<forge-summary><p>Ran the integration suite.</p></forge-summary>' +
  '</forge-review>';

const MERMAID = 'flowchart LR\n  A["x"] --> B["y<br/>z"]';

describe('ISS-898 body format columns', () => {
  let harness: TestDatabase;
  let insertComment: typeof import('../../src/comments/service.js').insertComment;
  let updateCommentBody: typeof import('../../src/comments/service.js').updateCommentBody;
  let createIssue: typeof import('../../src/issues/create-service.js').createIssue;
  let schema: typeof import('../../src/db/schema.js');

  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    ({ insertComment, updateCommentBody } = await import('../../src/comments/service.js'));
    ({ createIssue } = await import('../../src/issues/create-service.js'));
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
      .returning({ format: schema.comments.format, template: schema.comments.template });

    expect(row?.format).toBe('markdown');
    expect(row?.template).toBeNull();

    const [issue] = await harness.db
      .select({
        format: schema.issues.descriptionFormat,
        template: schema.issues.descriptionTemplate,
      })
      .from(schema.issues)
      .where(sql`${schema.issues.id} = ${issueId}`);
    expect(issue?.format).toBe('markdown');
    expect(issue?.template).toBeNull();
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

  it('stores a component comment with its template and reads the slots back', async () => {
    const issueId = await anIssue();
    const written = await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      body: REVIEW_BODY,
      format: 'html',
      parentId: null,
    });

    expect(written.row.format).toBe('html');
    expect(written.row.template).toBe('forge-review');
    expect(written.warnings).toEqual([]);

    const { bodySlots, bodyText } = await import('../../src/body/prepare.js');
    const [stored] = await harness.db
      .select({ body: schema.comments.body, format: schema.comments.format })
      .from(schema.comments)
      .where(sql`${schema.comments.id} = ${written.row.id}`);
    expect(bodySlots(stored?.body ?? '', stored?.format)).toMatchObject({
      sha: '60e8d635',
      verdict: 'request-changes',
    });
    expect(bodyText(stored?.body ?? '', stored?.format)).toContain('runs-cascade.ts:42');
  });

  it('refuses an invalid component body and leaves the table empty', async () => {
    const issueId = await anIssue();
    await expect(
      insertComment({
        issueId,
        authorId: userId,
        authorDeviceId: null,
        body: REVIEW_BODY.replace('verdict="request-changes"', 'verdict="approved"'),
        format: 'html',
        parentId: null,
      }),
    ).rejects.toThrow(/forge-review@verdict/);

    const rows = await harness.db.select().from(schema.comments);
    expect(rows).toHaveLength(0);
  });

  it('round-trips a mermaid diagram through Postgres byte-identically', async () => {
    const issueId = await anIssue();
    const body = `<forge-diagram kind="mermaid">${MERMAID}</forge-diagram>`;
    const written = await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      body,
      format: 'html',
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

  it('update re-validates and can place a forge-artifact after the fact', async () => {
    const issueId = await anIssue();
    const created = await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      body: 'here is the report',
      format: 'html',
      parentId: null,
    });
    expect(created.row.format).toBe('html');
    expect(created.row.body).toBe('<p>here is the report</p>');

    const artifact = `<forge-artifact id="${randomUUID()}" />`;
    const updated = await updateCommentBody(created.row.id, { body: artifact, format: 'html' });
    expect(updated?.row.template).toBe('forge-artifact');

    await expect(
      updateCommentBody(created.row.id, {
        body: '<forge-artifact id="not-a-uuid" />',
        format: 'html',
      }),
    ).rejects.toThrow(/forge-artifact@id/);
  });

  it('stores an issue description as a component and defaults the rest to markdown', async () => {
    const html =
      '<forge-symptom><forge-opening><p>It 500s on every load.</p></forge-opening>' +
      '<forge-evidence><forge-row date="2026-09-03" measured="12 requests" source="sentry" />' +
      '</forge-evidence></forge-symptom>';

    const result = await createIssue(
      { projectId, title: 'a symptom', description: html, descriptionFormat: 'html' },
      {
        createdById: userId,
        createdVia: 'web',
        actor: { type: 'user', id: userId, agency: 'human' },
      },
    );
    if (result.deduped) throw new Error('unexpected dedupe');
    expect(result.issue.descriptionFormat).toBe('html');
    expect(result.issue.descriptionTemplate).toBe('forge-symptom');

    const plain = await createIssue(
      { projectId, title: 'a markdown issue', description: '## Problem\n\nIt 500s.' },
      {
        createdById: userId,
        createdVia: 'web',
        actor: { type: 'user', id: userId, agency: 'human' },
      },
    );
    if (plain.deduped) throw new Error('unexpected dedupe');
    expect(plain.issue.descriptionFormat).toBe('markdown');
    expect(plain.issue.description).toBe('## Problem\n\nIt 500s.');
  });
});
