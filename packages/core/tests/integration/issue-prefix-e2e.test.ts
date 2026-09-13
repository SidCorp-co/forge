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
  // cm:guard every core import here is DYNAMIC and happens after the env above is set — `db/client.ts` binds its pool at module load, so a static import resolves the wrong database before a case runs.
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

  // cm:why The criterion that reads "is accepted" is not enough: a service that returns success without moving the pointer passes it while the project goes on rendering FX-977.
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
  // cm:why criterion 11 — the pointer and the claim cannot diverge, because Postgres will not hold it.
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

  // cm:why criterion 9 — deleting the holder must NOT free the name, or a published FD-977 silently re-points at a different project's issue 977.
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

  // cm:why criterion 10 — two callers racing for one free prefix get one success and one refusal.
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

  // cm:why the same project on both sides is NOT a conflict: the state the loser asked for is the state that now holds, and reporting `taken` against its own holder refuses a request that has already succeeded (codex review of ISS-992).
  it('answers both callers ok when ONE project races itself for a free prefix', async () => {
    const a = await project();
    const results = await Promise.all([assign(a.id, 'FD'), assign(a.id, 'FD')]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await activePrefixOf(a.id)).toBe('FD');
  });
});

// cm:guard Postgres's own words are on `err.cause`, not on the DrizzleQueryError that wraps it — a `rejects.toThrow(/…/)` here matches the wrapper's generic "Failed query" and passes for ANY database error, which is a green that says nothing about which rule refused.
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

  // cm:why the trigger, not the application: the guard on `issuePrefixAliases` says the table is insert-only, and until this ran nothing but that sentence enforced it (codex review of ISS-992).
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

  // cm:why the tombstone is the ONE mutation the design needs, so the trigger has to let it through — a trigger that refused it would break project deletion instead.
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

  // cm:why a direct write of `fd` coexists with `FD` under the case-sensitive unique index, and both projects then answer to the same apparent FD-977.
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

  // cm:guard `issue_dependencies.project_id` scopes the EDGE and constrains NEITHER endpoint, so a cross-project edge is representable — naming the far end under the near end's prefix reports a reference that exists and points somewhere else (codex review of ISS-992)
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
  // cm:why criteria 22 and 23 — the stored key stays canonical, so admission still finds it.
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

  // cm:guard criterion 23 — admission matches the stored `runIssues` key by SQL string CONTAINMENT, and the stored form is canonical. Take `issue_prefix` into account in that predicate and it stops matching: the run's own issue is offered to a second box as free work, which is the cross-box conflict ISS-933 criterion 7 exists to prevent.
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
