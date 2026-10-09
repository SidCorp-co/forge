/**
 * ISS-1372 — an issue edit and a status move do the same things whichever door they come in by.
 *
 * REST `PATCH /api/issues/:id` and `POST /api/issues/:id/transition` emit `issueUpdated`, record the
 * reason, bound it, and announce the unblock; `forge_issues` update and transition reach the same
 * rows through the same services, and each of those effects was missing from the tool. This file
 * drives both doors with one edit and one move and reads the same effects off each, so a door that
 * drops one goes red naming itself.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRest, callTool, eventually, seedRoles } from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let member: { jwt: string; pat: string; userId: string };
let publish: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
  const { roomManager } = await import('../../src/ws/server.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 180_000);

afterAll(async () => {
  publish?.mockRestore();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  publish.mockClear();
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  ownerId = seeded.ownerId;
  member = seeded.callers.member;
});

let seq = 0;
async function issue(status = 'open'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})`);
  return id;
}

async function blocks(blocker: string, dependent: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    VALUES (${projectId}, ${blocker}, ${dependent}, 'blocks')`);
}

async function updatedRows(issueId: string) {
  return (await harness.db.execute(
    sql`SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'issue.updated'`,
  )) as unknown as Array<{ payload: { fields: string[]; before: unknown; after: unknown } }>;
}

type Edit = (id: string, title: string) => Promise<{ refused?: string }>;

const edits: Record<string, Edit> = {
  'REST PATCH /api/issues/:id': (id, title) =>
    callRest(server.baseUrl, member.jwt, 'PATCH', `/api/issues/${id}`, { title }),
  'forge_issues update': (id, title) =>
    callTool(member.pat, 'forge_issues', {
      action: 'update',
      projectId,
      documentId: id,
      data: { title },
    }),
};

describe.each(Object.entries(edits))('a title edit through %s', (_name, edit) => {
  it('records one issue.updated row naming the field and both values', async () => {
    const id = await issue();
    expect(await edit(id, 'a clearer title')).not.toHaveProperty('refused');
    const rows = await eventually(async () => {
      const r = await updatedRows(id);
      return r.length > 0 ? r : undefined;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.fields).toEqual(['title']);
    expect(rows[0]?.payload.after).toEqual({ title: 'a clearer title' });
  });
});

type Move = (id: string, toStatus: string, reason: string) => Promise<{ refused?: string }>;

const moves: Record<string, Move> = {
  'REST POST /api/issues/:id/transition': (id, toStatus, reason) =>
    callRest(server.baseUrl, member.jwt, 'POST', `/api/issues/${id}/transition`, {
      toStatus,
      reason,
    }),
  'forge_issues transition': (id, toStatus, reason) =>
    callTool(member.pat, 'forge_issues', {
      action: 'transition',
      projectId,
      documentId: id,
      data: { status: toStatus, reason },
    }),
};

function published(event: string) {
  return publish.mock.calls
    .map((c) => c[1] as { event: string; data: Record<string, unknown> })
    .filter((m) => m.event === event);
}

describe.each(Object.entries(moves))('a drop through %s', (_name, move) => {
  it('hands the reason it was given to the status-changed broadcast', async () => {
    const id = await issue();
    expect(await move(id, 'dropped', 'superseded by another change')).not.toHaveProperty('refused');
    const [changed] = published('issue.statusChanged');
    expect(changed?.data.reason).toBe('superseded by another change');
  });

  it('announces the dependents the drop unblocked', async () => {
    const blocker = await issue();
    const dependent = await issue();
    await blocks(blocker, dependent);
    expect(await move(blocker, 'dropped', 'not needed')).not.toHaveProperty('refused');
    const [cascade] = published('issue.unblockCascade');
    expect(cascade?.data.blockerId).toBe(blocker);
  });

  it('refuses a reason over 2000 characters by name and moves nothing', async () => {
    const id = await issue();
    const { refused } = await move(id, 'dropped', 'x'.repeat(2001));
    expect(refused, 'a reason past the bound must be refused').toBeDefined();
    const rows = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${id}`,
    )) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('open');
  });
});
