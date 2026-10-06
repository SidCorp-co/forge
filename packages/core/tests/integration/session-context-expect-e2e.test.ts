/**
 * ISS-959 A — a `sessionContext` write may carry the value it read, and is
 * refused when the field moved.
 *
 * This runs against a real Postgres because the whole rule IS the SQL: the
 * precondition is compared against the composed value (`issue_session_context()`,
 * ISS-54: the lease lives on `issue_work_state`) read `FOR UPDATE` inside the
 * write's own transaction, and a fake query builder cannot tell that apart from
 * a read-then-write, which is the exact race the rule closes.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { splitSessionContext, writeSplitSessionContext } from '../../src/issues/work-state.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

describe('ISS-959 A — conditional sessionContext write', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  async function seed(sessionContext?: Record<string, unknown>) {
    const user = await createTestUser({ verified: true });
    const project = await createTestProject(user.id);
    await addProjectMember(project.id, user.id, 'admin');
    const id = randomUUID();
    const split = splitSessionContext(sessionContext ?? null);
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
      VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)}, 'lease', 'open',
              ${user.id}, ${split.rest ? JSON.stringify(split.rest) : null}::text::jsonb)
    `);
    if (split.lease.present || split.branch) await writeSplitSessionContext(db, id, split);
    const token = await userToken(user.id);
    return { id, token };
  }

  const patch = (id: string, token: string, body: unknown) =>
    api(token, 'PATCH', `/api/issues/${id}`, body);

  /** The blob a reader is served: the column with the work state's lease composed back in. */
  async function storedContext(id: string): Promise<unknown> {
    const [row] = await rows<{ session_context: unknown }>(
      sql`SELECT issue_session_context(id, session_context) AS session_context FROM issues WHERE id = ${id}`,
    );
    return row?.session_context;
  }

  /** The one refusal a refused write carries, by its code and the field it names. */
  function mismatch(res: ApiResponse): { code: string; path: string } | undefined {
    const refusals = (res.body.error as { refusals?: Array<{ code: string; path: string }> })
      ?.refusals;
    expect(res.body.code).toBe(refusals?.[0]?.code);
    const first = refusals?.[0];
    return first && { code: first.code, path: first.path };
  }

  const leaseA = { lease: { holder: 'session-a', pid: '1' } };
  const leaseB = { lease: { holder: 'session-b', pid: '2' } };

  it('AC1 — a write with no `expect` stores the value, exactly as before this change', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, { sessionContext: leaseB });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC2 — the first writer carrying the value it read stores its own value', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC3/AC4/AC8 — the second writer holding the same read value is refused naming the field that moved, and stores nothing', async () => {
    const { id, token } = await seed(leaseA);
    const first = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(first.status).toBe(200);

    const loser = { lease: { holder: 'session-c', pid: '3' } };
    const second = await patch(id, token, {
      sessionContext: loser,
      expect: { sessionContext: leaseA },
    });
    expect(second.status).toBe(422);
    expect(mismatch(second)).toEqual({
      code: 'SESSION_CONTEXT_MISMATCH',
      path: '/expect/sessionContext',
    });
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC5 — `expect: { sessionContext: null }` succeeds while the field holds no value', async () => {
    const { id, token } = await seed();
    const res = await patch(id, token, {
      sessionContext: leaseA,
      expect: { sessionContext: null },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseA);
  });

  it('AC6 — `expect: { sessionContext: null }` is refused while the field holds a value', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: null },
    });
    expect(res.status).toBe(422);
    expect(mismatch(res)?.code).toBe('SESSION_CONTEXT_MISMATCH');
    expect(await storedContext(id)).toEqual(leaseA);
  });

  it('AC7 — an `expect` differing only in key order is accepted', async () => {
    const stored = { lease: { holder: 'session-a', pid: '1' }, branch: 'ISS-959' };
    const { id, token } = await seed(stored);
    const reordered = { branch: 'ISS-959', lease: { pid: '1', holder: 'session-a' } };
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: reordered },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC10 — an `expect` on an issue id that does not exist is not-found, never a mismatch', async () => {
    const { token } = await seed(leaseA);
    const res = await patch(randomUUID(), token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(res.status).toBe(404);
    const body = res.body as unknown as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('refuses an `expect` sent with no field to write — a compare-and-set that writes nothing is a read wearing a write verb', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, { expect: { sessionContext: leaseA } });
    expect(res.status).toBe(400);
  });

  it('holds the precondition against a write of ANOTHER field the lease covers', async () => {
    const { id, token } = await seed(leaseA);
    const refused = await patch(id, token, {
      plan: 'the plan',
      expect: { sessionContext: leaseB },
    });
    expect(refused.status).toBe(422);
    expect(mismatch(refused)?.code).toBe('SESSION_CONTEXT_MISMATCH');

    const accepted = await patch(id, token, {
      plan: 'the plan',
      expect: { sessionContext: leaseA },
    });
    expect(accepted.status).toBe(200);
    const [row] = await rows<{ plan: string | null }>(
      sql`SELECT plan FROM issues WHERE id = ${id}`,
    );
    expect(row?.plan).toBe('the plan');
  });

  it('two concurrent writers on the same read value: exactly one wins', async () => {
    const { id, token } = await seed(leaseA);
    const [one, two] = await Promise.all([
      patch(id, token, { sessionContext: leaseB, expect: { sessionContext: leaseA } }),
      patch(id, token, {
        sessionContext: { lease: { holder: 'session-c', pid: '3' } },
        expect: { sessionContext: leaseA },
      }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 422]);
    const winner = one.status === 200 ? leaseB : { lease: { holder: 'session-c', pid: '3' } };
    expect(await storedContext(id)).toEqual(winner);
  });
});
