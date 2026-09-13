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
}, 300_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
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

  it('refuses a key under a prefix the project does not hold, by name', async () => {
    const p = await project();
    await assign(p.id, 'FD');
    const deviceId = (await createTestDevice(harness.db, userId)).id;
    await expect(
      openRunSession({ deviceId, projectId: p.id, issueKeys: ['FP-977'], name: 'foreign' }),
    ).rejects.toThrow(/FP/);
  });
});
