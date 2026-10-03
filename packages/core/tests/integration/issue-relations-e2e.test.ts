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
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
      VALUES (${id}, ${projectId}, ${seq}, ${`Issue ${seq}`}, ${status}, ${ownerId},
              CASE WHEN ${status} = 'closed' THEN now() END)
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

  it('puts the blocker in blocks.incoming and the dependent in blocks.outgoing, from each side', async () => {
    const blocker = await insertIssue(101, 'in_progress');
    const dependent = await insertIssue(102);
    await insertEdge(blocker, dependent, 'blocks');

    const onDependent = await loadIssueRelations(dependent, projectId);
    expect(onDependent.blocks.outgoing).toEqual([]);
    expect(onDependent.blocks.incoming).toHaveLength(1);
    expect(onDependent.blockedBy.map((e) => e.otherIssueId)).toEqual([blocker]);
    expect(onDependent.blocks.incoming[0]).toMatchObject({
      fromIssueId: blocker,
      toIssueId: dependent,
      otherIssueId: blocker,
      otherDisplayId: 'ISS-101',
      otherStatus: 'in_progress',
      kind: 'blocks',
      expired: false,
      blocking: true,
    });

    const onBlocker = await loadIssueRelations(blocker, projectId);
    expect(onBlocker.blocks.incoming).toEqual([]);
    expect(onBlocker.blocks.outgoing).toHaveLength(1);
    expect(onBlocker.blocks.outgoing[0]).toMatchObject({
      otherIssueId: dependent,
      otherDisplayId: 'ISS-102',
    });
  });

  it('reports a past validUntil as expired and no longer gating', async () => {
    const blocker = await insertIssue(201);
    const dependent = await insertIssue(202);
    await insertEdge(blocker, dependent, 'blocks', '2020-01-01T00:00:00.000Z');

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge?.expired).toBe(true);
    expect(edge?.blocking).toBe(false);
    expect(edge?.validUntil).toBeInstanceOf(Date);
  });

  it('keeps a future validUntil live', async () => {
    const blocker = await insertIssue(211);
    const dependent = await insertIssue(212);
    await insertEdge(blocker, dependent, 'blocks', '2099-01-01T00:00:00.000Z');

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge?.expired).toBe(false);
  });

  it('does not report a decomposes parent as a dispatch blocker', async () => {
    const parent = await insertIssue(301);
    const child = await insertIssue(302);
    await insertEdge(parent, child, 'decomposes');

    const relations = await loadIssueRelations(child, projectId);
    expect(relations.blocks.incoming).toEqual([]);
    const [edge] = relations.decomposes.incoming;
    expect(edge?.kind).toBe('decomposes');
    expect(edge?.expired).toBe(false);
    expect(edge?.blocking).toBe(false);
  });

  it('stops gating once the blocker has merged, the way L2 does', async () => {
    const blocker = await insertIssue(601, 'awaiting_release');
    const dependent = await insertIssue(602);
    await insertEdge(blocker, dependent, 'blocks');
    await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${blocker}`);

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge?.expired).toBe(false);
    expect(edge?.otherMergedAt).toBeInstanceOf(Date);
  });

  it('reports a reopened blocker with its merge stamp intact', async () => {
    const blocker = await insertIssue(611, 'reopen');
    const dependent = await insertIssue(612);
    await insertEdge(blocker, dependent, 'blocks');
    await harness.db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${blocker}`);

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge?.otherStatus).toBe('reopen');
    expect(edge?.otherMergedAt).not.toBeNull();
  });

  // ISS-1108 moved this case off `closed`: `closed` now means the work shipped and the
  // database refuses a closed row with no `merged_at`, so a terminal blocker whose code
  // never landed is a `dropped` one. The projection is what is under test either way.
  it('reports a terminal blocker whose code never landed with a null stamp', async () => {
    const blocker = await insertIssue(621, 'dropped');
    const dependent = await insertIssue(622);
    await insertEdge(blocker, dependent, 'blocks');

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge?.otherMergedAt).toBeNull();
  });

  it('omits the other issue title and the edge reason', async () => {
    const blocker = await insertIssue(401);
    const dependent = await insertIssue(402);
    await insertEdge(blocker, dependent, 'blocks');

    const [edge] = (await loadIssueRelations(dependent, projectId)).blocks.incoming;
    expect(edge).toBeDefined();
    expect(JSON.stringify(edge)).not.toContain('Issue 401');
    expect(Object.keys(edge ?? {})).not.toContain('reason');
  });

  it('returns an empty graph for an issue with no edges', async () => {
    const lonely = await insertIssue(501);
    const none = { outgoing: [], incoming: [] };
    expect(await loadIssueRelations(lonely, projectId)).toEqual({
      blocks: none,
      relates: none,
      duplicates: none,
      parent: none,
      decomposes: none,
      blockedBy: [],
    });
  });
});
