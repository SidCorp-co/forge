/**
 * The setup every "one capability, two doors" suite shares: a project with an owner, a viewer, a
 * member and an admin, each holding a user JWT for REST and a PAT for MCP, and a caller for each
 * door that answers `{}` when the door admitted the call and `{ refused }` when it did not.
 */

import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';
import { createTestProject, createTestProjectMember, createTestUser } from './factories.js';
import { connectClientAsPat, parseToolResult } from './mcp-harness.js';

export type Role = 'viewer' | 'member' | 'admin';
export type Caller = { userId: string; jwt: string; pat: string };
export type Door = { refused?: string; body?: unknown };

export async function seedRoles(db: TestDb): Promise<{
  ownerId: string;
  projectId: string;
  callers: Record<Role, Caller>;
}> {
  const owner = await createTestUser(db);
  const projectId = (await createTestProject(db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');

  const built: Partial<Record<Role, Caller>> = {};
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const user = await createTestUser(db);
    await db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    await createTestProjectMember(db, { userId: user.id, projectId, role });
    built[role] = {
      userId: user.id,
      jwt: await signUserToken(user.id),
      pat: (await mintPat({ userId: user.id, name: role, scopes: ['read', 'write', 'admin'] }))
        .plaintext,
    };
  }
  return { ownerId: owner.id, projectId, callers: built as Record<Role, Caller> };
}

export async function callRest(
  baseUrl: string,
  bearer: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Door & { status: number }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status >= 300) return { status: res.status, refused: text };
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function callTool(
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Door> {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    if (res.isError) return { refused: res.content[0]?.text ?? '' };
    return { body: parseToolResult(res) };
  } finally {
    await ctx.close();
  }
}

/** Waits for `read` to return something other than `undefined`, for the hooks that write behind a response. */
export async function eventually<T>(read: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('eventually: nothing arrived in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
