/**
 * ISS-868 — `loadIssueRelations` against real Postgres. The MCP `get` payload
 * is the only read path an agent has onto its own edges, and every claim it
 * makes is directional: which side of the edge this issue is on, and whether
 * the edge still gates dispatch. A mocked reader cannot prove either, so the
 * two joins and the expiry predicate are exercised here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type ReadModule = typeof import('../../src/issues/dependency-read.js');

describe('ISS-868 issue relations read', () => {
  let harness: TestDatabase;
  let loadIssueRelations: ReadModule['loadIssueRelations'];
  let projectId: string;
  let ownerId: string;

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
    ({ loadIssueRelations } = await import('../../src/issues/dependency-read.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    ownerId = user.id;
    projectId = project.id;
  });

  async function insertIssue(seq: number, status = 'open'): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`Issue ${seq}`}, ${status}, ${ownerId})
    `);
    return id;
  }

  async function insertEdge(
    from: string,
    to: string,
    kind: string,
    validUntil: string | null = null,
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, created_by_id, valid_until)
      VALUES (${randomUUID()}, ${projectId}, ${from}, ${to}, ${kind}, ${ownerId}, ${validUntil}::timestamptz)
    `);
  }

  it('puts the blocker in blockedBy and the dependent in blocks, from each side', async () => {
    const blocker = await insertIssue(101, 'developed');
    const dependent = await insertIssue(102);
    await insertEdge(blocker, dependent, 'blocks');

    const onDependent = await loadIssueRelations(dependent);
    expect(onDependent.blocks).toEqual([]);
    expect(onDependent.blockedBy).toHaveLength(1);
    expect(onDependent.blockedBy[0]).toMatchObject({
      fromIssueId: blocker,
      toIssueId: dependent,
      otherIssueId: blocker,
      otherDisplayId: 'ISS-101',
      otherStatus: 'developed',
      kind: 'blocks',
      expired: false,
      gatesDispatch: true,
    });

    const onBlocker = await loadIssueRelations(blocker);
    expect(onBlocker.blockedBy).toEqual([]);
    expect(onBlocker.blocks).toHaveLength(1);
    expect(onBlocker.blocks[0]).toMatchObject({
      otherIssueId: dependent,
      otherDisplayId: 'ISS-102',
      gatesDispatch: false,
    });
  });

  it('reports a past validUntil as expired and no longer gating', async () => {
    const blocker = await insertIssue(201);
    const dependent = await insertIssue(202);
    await insertEdge(blocker, dependent, 'blocks', '2020-01-01T00:00:00.000Z');

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge?.expired).toBe(true);
    expect(edge?.gatesDispatch).toBe(false);
    expect(edge?.validUntil).toBeInstanceOf(Date);
  });

  it('keeps a future validUntil live', async () => {
    const blocker = await insertIssue(211);
    const dependent = await insertIssue(212);
    await insertEdge(blocker, dependent, 'blocks', '2099-01-01T00:00:00.000Z');

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge?.expired).toBe(false);
    expect(edge?.gatesDispatch).toBe(true);
  });

  it('does not report a decomposes parent as a dispatch blocker', async () => {
    const parent = await insertIssue(301);
    const child = await insertIssue(302);
    await insertEdge(parent, child, 'decomposes');

    const [edge] = (await loadIssueRelations(child)).blockedBy;
    expect(edge?.kind).toBe('decomposes');
    expect(edge?.expired).toBe(false);
    expect(edge?.gatesDispatch).toBe(false);
  });

  it('stops gating once the blocker has merged, the way L2 does', async () => {
    const blocker = await insertIssue(601, 'released');
    const dependent = await insertIssue(602);
    await insertEdge(blocker, dependent, 'blocks');
    await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${blocker}`);

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge?.expired).toBe(false);
    expect(edge?.otherMergedAt).toBeInstanceOf(Date);
    expect(edge?.gatesDispatch).toBe(false);
  });

  it('gates again while a merged blocker sits at reopen — merged_at is never cleared', async () => {
    const blocker = await insertIssue(611, 'reopen');
    const dependent = await insertIssue(612);
    await insertEdge(blocker, dependent, 'blocks');
    await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${blocker}`);

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge?.gatesDispatch).toBe(true);
  });

  it('still gates on a closed blocker whose code never landed, on a stampable base', async () => {
    const blocker = await insertIssue(621, 'closed');
    const dependent = await insertIssue(622);
    await insertEdge(blocker, dependent, 'blocks');

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge?.otherMergedAt).toBeNull();
    expect(edge?.gatesDispatch).toBe(true);
  });

  it('omits the other issue title and the edge reason', async () => {
    const blocker = await insertIssue(401);
    const dependent = await insertIssue(402);
    await insertEdge(blocker, dependent, 'blocks');

    const [edge] = (await loadIssueRelations(dependent)).blockedBy;
    expect(edge).toBeDefined();
    expect(JSON.stringify(edge)).not.toContain('Issue 401');
    expect(Object.keys(edge ?? {})).not.toContain('reason');
  });

  it('returns an empty graph for an issue with no edges', async () => {
    const lonely = await insertIssue(501);
    expect(await loadIssueRelations(lonely)).toEqual({ blocks: [], blockedBy: [] });
  });
});
