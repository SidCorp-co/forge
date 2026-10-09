/**
 * The ground the REQ-36 suites stand on: `issue-patterns-e2e`, `issue-pattern-doors-e2e`,
 * `issue-pattern-entry-orders-e2e` and `issue-design-e2e`. A project declaring the repository it is
 * built from, which decides whether Forge reads its pattern catalog; a caller acting as one of the
 * suite's named accounts; and the reads every case takes of an answer and of an issue's status.
 */

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { api } from './api.js';
import type { Doc } from './ecosystem-world.js';
import { createTestProject, rows } from './factories.js';
import { seedProjectDocument } from './release-world.js';

export type Res = { status: number; body: Doc };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * A project owned by `ownerId` whose document declares `repository` as its git source, deploying
 * from `main`; `null` leaves the project with no document at all.
 */
export async function projectBuiltFrom(
  ownerId: string,
  repository: string | null,
): Promise<string> {
  const { id } = await createTestProject(ownerId);
  if (repository === null) return id;
  await seedProjectDocument(id, ownerId, {
    environments: {
      dev: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
    source: { type: 'git', git: { repository, defaultBranch: 'main', branches: ['main'] } },
  });
  return id;
}

/**
 * A call through the app as one of `tokens`' accounts. The token is read when the call is made, so
 * the suite fills `tokens` in its `beforeAll` after building the caller.
 */
export function callerFor<K extends string>(tokens: Record<K, string>) {
  return async (who: K, method: Method, path: string, body?: unknown): Promise<Res> => {
    const res = await api(tokens[who], method, path, body);
    return { status: res.status, body: res.body as Doc };
  };
}

/** The body of an answer that came back with `status`, failing the case naming the body if not. */
export function ok(res: Res, status = 200): Doc {
  expect([res.status, res.body]).toEqual([status, expect.anything()]);
  return res.body;
}

/** The code of each refusal an answer carries, in order; none for an answer that refused nothing. */
export const refusalCodes = (res: { body: Doc }): string[] =>
  (res.body?.error?.refusals ?? []).map((r: Doc) => r.code);

/** The issue's status as the row holds it. */
export const statusOf = async (issue: string): Promise<string | undefined> =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issue}`))[0]?.status;
