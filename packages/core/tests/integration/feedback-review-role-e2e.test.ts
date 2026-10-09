/**
 * ISS-1372 — one role stamps a feedback report reviewed, whichever door it comes in by.
 *
 * REST `POST /api/feedback-reports/:id/reviewed` resolves the caller's role on the report's project
 * and refuses a viewer; `forge_feedback action=review` is the same capability and answered any
 * non-null role. This file drives both doors as a viewer, a member and an admin, so a door that
 * admits a role the other refuses goes red naming itself. A refused stamp leaves the report
 * unreviewed. The list is the other half: both doors answer from one service function, so the
 * same project, filters and limit return the same report ids in the same order.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

type Role = 'viewer' | 'member' | 'admin';
type Caller = { jwt: string; pat: string };

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let callers: Record<Role, Caller>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');

  const built: Partial<Record<Role, Caller>> = {};
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    await createTestProjectMember(harness.db, { userId: user.id, projectId, role });
    built[role] = {
      jwt: await signUserToken(user.id),
      pat: (await mintPat({ userId: user.id, name: role, scopes: ['read', 'write', 'admin'] }))
        .plaintext,
    };
  }
  callers = built as Record<Role, Caller>;
});

const SIGNAL_KEY = 'self_report:skill:-:friction';

async function report(): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO feedback_reports (id, project_id, kind, target, summary, signal_key)
    VALUES (${id}, ${projectId}, 'friction', 'skill', 'a step was unclear', ${SIGNAL_KEY})`);
  return id;
}

async function reviewedAt(id: string): Promise<Date | null> {
  const rows = (await harness.db.execute(
    sql`SELECT reviewed_at FROM feedback_reports WHERE id = ${id}`,
  )) as unknown as Array<{ reviewed_at: Date | null }>;
  return rows[0]?.reviewed_at ?? null;
}

type Door = (who: Caller, reportId: string) => Promise<{ refused?: string }>;

async function mcp(pat: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_feedback', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    if (res.isError) return { refused: res.content[0]?.text ?? '' };
    parseToolResult(res);
    return {};
  } finally {
    await ctx.close();
  }
}

const doors: Record<string, Door> = {
  'REST POST /api/feedback-reports/:id/reviewed': async (who, id) => {
    const res = await fetch(`${server.baseUrl}/api/feedback-reports/${id}/reviewed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${who.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: true }),
    });
    const body = await res.text();
    return res.status < 300 ? {} : { refused: body };
  },
  'forge_feedback review by reportId': (who, id) =>
    mcp(who.pat, { action: 'review', projectId, reportId: id, reviewed: true }),
  'forge_feedback review by signalKey': (who) =>
    mcp(who.pat, { action: 'review', projectId, signalKey: SIGNAL_KEY, reviewed: true }),
};

describe.each(Object.entries(doors))('%s', (_name, stamp) => {
  it('refuses a viewer and leaves the report unreviewed', async () => {
    const id = await report();
    const { refused } = await stamp(callers.viewer, id);
    expect(refused, 'a viewer must not be able to stamp a report reviewed').toBeDefined();
    expect(await reviewedAt(id)).toBeNull();
  });

  it.each(['member', 'admin'] as const)(
    'admits a project %s and stamps the report',
    async (role) => {
      const id = await report();
      expect(await stamp(callers[role], id)).toEqual({});
      expect(await reviewedAt(id)).not.toBeNull();
    },
  );
});

describe('the feed', () => {
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await harness.db.execute(sql`
        INSERT INTO feedback_reports (project_id, kind, target, summary, signal_key, created_at)
        VALUES (${projectId}, 'friction', 'skill', ${`report ${i}`}, ${`k${i}`},
                now() - (${i} * interval '1 minute'))`);
    }
  }

  async function viaRest(limit: number, reviewed: boolean): Promise<string[]> {
    const res = await fetch(
      `${server.baseUrl}/api/feedback-reports?projectId=${projectId}&limit=${limit}&reviewed=${reviewed}`,
      { headers: { Authorization: `Bearer ${callers.member.jwt}` } },
    );
    return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
  }

  async function viaTool(limit: number, reviewed: boolean): Promise<string[]> {
    const ctx = await connectClientAsPat(callers.member.pat);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_feedback',
        arguments: { action: 'list', projectId, limit, filters: { reviewed } },
      })) as { content: Array<{ type: string; text: string }> };
      const body = parseToolResult(res) as { reports: Array<{ id: string }> };
      return body.reports.map((r) => r.id);
    } finally {
      await ctx.close();
    }
  }

  it('lists the same report ids in the same order through both doors for one limit and filter', async () => {
    await seed(7);
    const rest = await viaRest(5, false);
    expect(rest).toHaveLength(5);
    expect(await viaTool(5, false)).toEqual(rest);
  });

  it('answers the reviewed filter the same way through both doors', async () => {
    await seed(3);
    const [first] = await viaRest(1, false);
    await harness.db.execute(
      sql`UPDATE feedback_reports SET reviewed_at = now() WHERE id = ${first}`,
    );
    expect(await viaTool(10, true)).toEqual(await viaRest(10, true));
    expect(await viaTool(10, true)).toEqual([first]);
  });
});
