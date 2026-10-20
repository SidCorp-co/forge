/**
 * ISS-1228 round 21 (judge-67, criterion 218) — the rescue pass read its stuck candidates with
 * LIMIT 100 and no ORDER BY. Beta held about 2,796 of them, and judge-67's project had one issue woken
 * twenty times and then nothing. The pass now reads the longest-unread first, so with 250 candidates
 * that stay stuck, three passes read 100 each, the first 250 reads name 250 different issues, and the
 * third pass takes the 50 never read before any it has read already.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** Every issue the pass examined, in the order it examined them; each is left capped, so stays stuck. */
const examined = vi.hoisted(() => [] as string[]);
vi.mock('../../src/pipeline/autonomous-rescue-cap.js', async (original) => ({
  ...(await original<typeof import('../../src/pipeline/autonomous-rescue-cap.js')>()),
  checkAutonomousRescueCap: async (args: { issueId: string }) => {
    examined.push(args.issueId);
    return { capped: true, runId: null };
  },
}));

let harness: TestDatabase;
let projectId: string;
let ownerId: string;

const STUCK = 250;
const PER_PASS = 100;
/** ⌈250 / 100⌉: the passes in which every one of the 250 is read. */
const PASSES = 3;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  examined.length = 0;
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, updated_at)
    SELECT gen_random_uuid(), ${projectId}, n, 'Stuck issue ' || n, 'open', ${ownerId}, now() - interval '10 minutes'
      FROM generate_series(1, ${STUCK}) AS n
  `);
});

describe('the rescue pass reads every stuck issue in turn (criterion 218)', () => {
  it(`reaches all ${STUCK} stuck issues in ${PASSES} passes and reads none twice before each once`, async () => {
    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    const perPass: string[][] = [];
    for (let pass = 0; pass < PASSES; pass++) {
      const before = examined.length;
      await runReconcilerOnce();
      perPass.push(examined.slice(before));
    }

    expect(perPass.map((p) => p.length)).toEqual([PER_PASS, PER_PASS, PER_PASS]);
    const firstReads = examined.slice(0, STUCK);
    expect(new Set(firstReads).size).toBe(STUCK);

    const [all] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${projectId}`,
    );
    expect(new Set(examined).size).toBe(all?.n);
    // The 101st candidate in id order is reached, which LIMIT with no order never promised.
    const [hundredFirst] = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM issues WHERE project_id = ${projectId} ORDER BY id OFFSET 100 LIMIT 1`,
    );
    expect(examined).toContain(hundredFirst?.id);
  });

  it('puts a row it has read behind every row it has not', async () => {
    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    await runReconcilerOnce();
    const first = new Set(examined);
    examined.length = 0;
    await runReconcilerOnce();
    expect(examined.filter((id) => first.has(id))).toEqual([]);
  });
});
