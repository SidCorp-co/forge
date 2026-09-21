/**
 * ISS-992 — the half of the issue prefix only a real database can hold.
 *
 * Three of this issue's criteria rest on Postgres rather than on a service remembering to check:
 * a project cannot be pointed at a prefix no alias of its own holds (the composite foreign key), a
 * prefix another project has ever held is refused (the unique index), and a deleted project keeps
 * its claim (the tombstone). The unit suite cannot represent any of them — it would be asserting
 * against a mock of the very constraint under test, which is a green that means nothing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let assignIssuePrefix: typeof import('../../src/issues/issue-prefix-service.js').assignIssuePrefix;
let heldIssuePrefixes: typeof import('../../src/issues/issue-prefix-read.js').heldIssuePrefixes;
let parseIssueRef: typeof import('../../src/lib/issue-ref.js').parseIssueRef;
let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
let loadIssueDependencyEdges: typeof import('../../src/issues/dependency-read.js').loadIssueDependencyEdges;
let readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  ({ assignIssuePrefix } = await import('../../src/issues/issue-prefix-service.js'));
  ({ heldIssuePrefixes } = await import('../../src/issues/issue-prefix-read.js'));
  ({ parseIssueRef } = await import('../../src/lib/issue-ref.js'));
  ({ openRunSession } = await import('../../src/devices/run-session.js'));
  ({ loadIssueDependencyEdges } = await import('../../src/issues/dependency-read.js'));
  ({ readAdmissibleIssues } = await import('../../src/devices/admissible.js'));
}, 300_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
});

async function project() {
  return createTestProject(harness.db, userId);
}

async function assign(projectId: string, prefix: string) {
  return assignIssuePrefix(projectId, prefix);
}

async function activePrefixOf(projectId: string): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT issue_prefix FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ issue_prefix: string | null }>;
  return rows[0]?.issue_prefix ?? null;
}

describe('assigning a prefix', () => {
  it('persists it and moves the active pointer', async () => {
    const p = await project();
    expect(await assign(p.id, 'FD')).toEqual({ ok: true, prefix: 'FD' });
    expect(await activePrefixOf(p.id)).toBe('FD');
  });

  it('upper-cases what it stores, so the unique index is the whole comparison', async () => {
    const p = await project();
    expect(await assign(p.id, 'fd')).toEqual({ ok: true, prefix: 'FD' });
    expect(await activePrefixOf(p.id)).toBe('FD');
  });

  it('keeps the retired prefix as an alias, so a published FD-977 still resolves', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    await assign(p.id, 'FX');
    expect(await activePrefixOf(p.id)).toBe('FX');
    expect((await heldIssuePrefixes(p.id)).sort()).toEqual(['FD', 'FX']);
  });

  it('moves the pointer BACK when a project returns to a prefix it already holds', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    await assign(p.id, 'FX');
    expect(await assign(p.id, 'FD')).toEqual({ ok: true, prefix: 'FD' });
    expect(await activePrefixOf(p.id)).toBe('FD');
  });

  it('refuses a prefix another project holds, naming that project', async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    expect(await assign(b.id, 'FD')).toEqual({
      ok: false,
      reason: 'taken',
      holderProjectId: a.id,
    });
    expect(await activePrefixOf(b.id)).toBeNull();
  });

  it('refuses a prefix another project has RETIRED, not just its active one', async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    await assign(a.id, 'FX');
    const out = await assign(b.id, 'FD');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out).toMatchObject({ reason: 'taken', holderProjectId: a.id });
  });

  it('refuses ISS and a malformed shape before it reaches the database', async () => {
    const p = await project();
    const reserved = await assign(p.id, 'ISS');
    expect(reserved.ok).toBe(false);
    if (!reserved.ok && reserved.reason !== 'taken') expect(reserved.reason).toBe('reserved');
    const shape = await assign(p.id, 'F');
    expect(shape.ok).toBe(false);
    if (!shape.ok && shape.reason !== 'taken') expect(shape.reason).toBe('shape');
    expect(await activePrefixOf(p.id)).toBeNull();
  });
});

describe('what the database refuses on its own', () => {
  it('refuses a projects row pointed at a prefix no alias of its own holds', async () => {
    const p = await project();
    await expect(
      harness.db.execute(sql`UPDATE projects SET issue_prefix = 'FD' WHERE id = ${p.id}`),
    ).rejects.toThrow();
  });

  it("refuses a projects row pointed at another project's alias", async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    await expect(
      harness.db.execute(sql`UPDATE projects SET issue_prefix = 'FD' WHERE id = ${b.id}`),
    ).rejects.toThrow();
  });

  it('keeps the claim as a tombstone when the holding project is deleted', async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${a.id}`);

    const rows = (await harness.db.execute(
      sql`SELECT project_id FROM issue_prefix_aliases WHERE prefix = 'FD'`,
    )) as unknown as Array<{ project_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBeNull();

    const out = await assign(b.id, 'FD');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out).toMatchObject({ reason: 'taken', holderProjectId: null });
  });

  it('turns the race into a refusal rather than a 500', async () => {
    const a = await project();
    const b = await project();
    const [first, second] = await Promise.all([assign(a.id, 'FD'), assign(b.id, 'FD')]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    if (!refused || refused.ok) throw new Error('expected exactly one refusal');
    expect(refused.reason).toBe('taken');
  });

  it('answers both callers ok when ONE project races itself for a free prefix', async () => {
    const a = await project();
    const results = await Promise.all([assign(a.id, 'FD'), assign(a.id, 'FD')]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await activePrefixOf(a.id)).toBe('FD');
  });
});

async function refusedBy(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) throw new Error(`expected a refusal matching ${pattern}`);
  const err = caught as { message?: string; cause?: { message?: string } };
  expect(`${err.cause?.message ?? ''} ${err.message ?? ''}`).toMatch(pattern);
}

describe('what the database refuses on its own, so a restore and a psql session are held to it too', () => {
  async function aliasOf(projectId: string): Promise<string> {
    const rows = (await harness.db.execute(
      sql`SELECT id FROM issue_prefix_aliases WHERE project_id = ${projectId} LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) throw new Error('no alias row');
    return id;
  }

  it('refuses a DELETE of an alias, spent or active', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    await refusedBy(
      harness.db.execute(sql`DELETE FROM issue_prefix_aliases WHERE id = ${id}`),
      /insert-only/,
    );
  });

  it('refuses a change of an alias prefix', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    await refusedBy(
      harness.db.execute(sql`UPDATE issue_prefix_aliases SET prefix = 'FX' WHERE id = ${id}`),
      /immutable/,
    );
  });

  it('refuses handing an alias to another project', async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    await refusedBy(
      harness.db.execute(
        sql`UPDATE issue_prefix_aliases SET project_id = ${b.id} WHERE id = ${id}`,
      ),
      /only go NULL/,
    );
  });

  it('refuses a tombstone written by hand while the project is still here', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    await refusedBy(
      harness.db.execute(sql`UPDATE issue_prefix_aliases SET project_id = NULL WHERE id = ${id}`),
      /tombstone belongs to the project FK/,
    );
    expect(await heldIssuePrefixes(a.id)).toEqual(['FD']);
  });

  it('refuses a hand-written tombstone from a session shadowing projects', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    await refusedBy(
      harness.db.transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE projects (id uuid PRIMARY KEY) ON COMMIT DROP`);
        await tx.execute(sql`UPDATE issue_prefix_aliases SET project_id = NULL WHERE id = ${id}`);
      }),
      /tombstone belongs to the project FK/,
    );
    expect(await heldIssuePrefixes(a.id)).toEqual(['FD']);
  });

  it.each(['id', 'created_at'])('refuses a change to %s', async (col) => {
    const a = await project();
    await assign(a.id, 'FD');
    const id = await aliasOf(a.id);
    const set =
      col === 'id' ? sql`id = gen_random_uuid()` : sql`created_at = now() - interval '1 year'`;
    await refusedBy(
      harness.db.execute(sql`UPDATE issue_prefix_aliases SET ${set} WHERE id = ${id}`),
      /id and created_at never change/,
    );
  });

  describe('a retired alias, which the composite foreign key does not cover', () => {
    async function retired(): Promise<{ projectId: string; aliasId: string }> {
      const a = await project();
      await assign(a.id, 'FD');
      await assign(a.id, 'FX');
      const rows = (await harness.db.execute(
        sql`SELECT id FROM issue_prefix_aliases WHERE project_id = ${a.id} AND prefix = 'FD'`,
      )) as unknown as Array<{ id: string }>;
      const aliasId = rows[0]?.id;
      if (!aliasId) throw new Error('no retired alias row');
      return { projectId: a.id, aliasId };
    }

    it('refuses deleting it', async () => {
      const { projectId, aliasId } = await retired();
      await refusedBy(
        harness.db.execute(sql`DELETE FROM issue_prefix_aliases WHERE id = ${aliasId}`),
        /insert-only/,
      );
      expect(await heldIssuePrefixes(projectId)).toEqual(['FD', 'FX']);
    });

    it('refuses handing it to another project', async () => {
      const { aliasId } = await retired();
      const b = await project();
      await refusedBy(
        harness.db.execute(
          sql`UPDATE issue_prefix_aliases SET project_id = ${b.id} WHERE id = ${aliasId}`,
        ),
        /only go NULL/,
      );
    });

    it('refuses a hand-written tombstone on it while the project is still here', async () => {
      const { projectId, aliasId } = await retired();
      await refusedBy(
        harness.db.execute(
          sql`UPDATE issue_prefix_aliases SET project_id = NULL WHERE id = ${aliasId}`,
        ),
        /tombstone belongs to the project FK/,
      );
      expect(await heldIssuePrefixes(projectId)).toEqual(['FD', 'FX']);
    });
  });

  it('still lets the project FK tombstone the alias on delete', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${a.id}`);
    const rows = (await harness.db.execute(
      sql`SELECT project_id FROM issue_prefix_aliases WHERE prefix = 'FD'`,
    )) as unknown as Array<{ project_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBeNull();
  });

  it.each(['fd', 'ISS', 'F', 'TOOLONG', 'F-D', '1FD'])(
    'refuses the stored prefix %s',
    async (p) => {
      const a = await project();
      await refusedBy(
        harness.db.execute(
          sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${a.id}, ${p})`,
        ),
        /prefix_shape/,
      );
    },
  );

  it.each(['FD', 'FP2', 'ABCDEF'])('accepts the stored prefix %s', async (p) => {
    const a = await project();
    await harness.db.execute(
      sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${a.id}, ${p})`,
    );
    expect(await heldIssuePrefixes(a.id)).toContain(p);
  });
});

describe('a reference under a prefix', () => {
  it('resolves under the legacy prefix, the active one and a retired one alike', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    await assign(p.id, 'FX');
    const held = await heldIssuePrefixes(p.id);
    for (const raw of ['977', 'ISS-977', 'FD-977', 'FX-977']) {
      expect(parseIssueRef(raw, held)).toEqual({ ok: true, issSeq: 977 });
    }
  });

  it('refuses a prefix belonging to a different project', async () => {
    const a = await project();
    const b = await project();
    await assign(a.id, 'FD');
    await assign(b.id, 'FP');
    const out = parseIssueRef('FP-977', await heldIssuePrefixes(a.id));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('FOREIGN_PREFIX');
  });
});

describe('an edge whose two ends sit in different projects', () => {
  async function issueIn(projectId: string, issSeq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, 'open', 'medium', ${userId})
    `);
    return id;
  }

  it("names each end with its own project's prefix", async () => {
    const fd = await project();
    const fx = await project();
    await assign(fd.id, 'FD');
    await assign(fx.id, 'FX');
    const blocker = await issueIn(fd.id, 7);
    const dependent = await issueIn(fx.id, 9);
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
      VALUES (${fx.id}, ${blocker}, ${dependent}, 'blocks')
    `);

    const edges = await loadIssueDependencyEdges(dependent, fx.id);
    expect(edges.incoming).toHaveLength(1);
    expect(edges.incoming[0]?.fromDisplayId).toBe('FD-7');
    expect(edges.incoming[0]?.toDisplayId).toBe('FX-9');
  });
});

describe('a run session under a prefixed project', () => {
  it('stores the canonical ISS- key whatever prefix the project holds', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${p.id}, 977, 'a prefixed issue', 'open', ${userId})
    `);

    const deviceId = (await createTestDevice(harness.db, userId)).id;

    const session = await openRunSession({
      deviceId,
      projectId: p.id,
      issueKeys: ['FD-977'],
      name: 'prefixed',
    });

    const rows = (await harness.db.execute(
      sql`SELECT metadata -> 'runIssues' AS keys FROM pipeline_runs WHERE id = ${session.runId}`,
    )) as unknown as Array<{ keys: string[] }>;
    expect(rows[0]?.keys).toEqual(['ISS-977']);
  });

  it("sees a FD project's issue in a run whose stored key reads ISS-977", async () => {
    const p = await project();
    await assign(p.id, 'FD');
    for (const seq of [977, 978]) {
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (${randomUUID()}, ${p.id}, ${seq}, ${`issue ${seq}`}, 'draft', ${userId})
      `);
    }
    const deviceId = (await createTestDevice(harness.db, userId)).id;
    await harness.db.execute(sql`
      UPDATE projects
         SET agent_config = ${JSON.stringify({ pipelineConfig: { poolBacklog: { statuses: ['draft'], limit: 20 } } })}::jsonb
       WHERE id = ${p.id}
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (${randomUUID()}, ${p.id}, ${deviceId}, 'r', 'claude-code', 'online')
    `);
    await openRunSession({ deviceId, projectId: p.id, issueKeys: ['FD-977'], name: 'prefixed' });

    const admitted = (await readAdmissibleIssues({ deviceId, projectId: p.id })).map(
      (a) => a.issueKey,
    );
    expect(admitted).not.toContain('FD-977');
    expect(admitted).toContain('FD-978');
  });

  it('refuses a key under a prefix the project does not hold, by name', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    const deviceId = (await createTestDevice(harness.db, userId)).id;
    await expect(
      openRunSession({ deviceId, projectId: p.id, issueKeys: ['FP-977'], name: 'foreign' }),
    ).rejects.toThrow(/FP/);
  });
});
