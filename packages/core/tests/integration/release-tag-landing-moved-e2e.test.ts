/**
 * ISS-1391 (review F1) — a close on a project that ships by tag is allowed on the landing commit a
 * tag was shown to hold, and on no other. The tag read is made before the transition's transaction
 * opens, so a mark cleared and made again on another commit while the repository is being read
 * would otherwise close the issue on a commit no tag was shown to hold. Here the repository is a
 * stand-in whose read can be held open, and the "someone else" is a plain UPDATE of the row during
 * it, against a real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** Runs while the tag list is being read, which is where a competing writer gets its turn. */
let whileReading: () => Promise<void> = async () => undefined;

vi.mock('../../src/projects/repository-access.js', () => ({
  withRepository: async (_projectId: string, fn: (access: unknown) => Promise<unknown>) =>
    fn({
      kind: 'reader',
      reader: {
        tagsContaining: async (commit: string) => {
          await whileReading();
          return { commit, matching: ['v1.0.0'], containing: ['v1.0.0'] };
        },
      },
    }),
}));

let harness: TestDatabase;
let transitionIssueStatus: typeof import('../../src/issues/apply-transition.js')['transitionIssueStatus'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.PAT_PEPPER ??= 'integration-test-pat-pepper-padded-to-32-chars-long';
  ({ transitionIssueStatus } = await import('../../src/issues/apply-transition.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  whileReading = async () => undefined;
  await truncateAll(harness.db);
});

async function seed() {
  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, user.id);
  await harness.db.execute(
    sql`UPDATE projects SET release_chain = '[{"branch":"main","tag":"v*"}]'::jsonb, base_branch = 'main' WHERE id = ${project.id}::uuid`,
  );
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status, merged_at, merged_commit_sha)
    VALUES (${id}::uuid, ${project.id}::uuid, 'a landing a tag holds', ${user.id}::uuid,
            'awaiting_release', now(), ${A})
  `);
  return { userId: user.id, projectId: project.id, id };
}

const close = (w: { userId: string; projectId: string; id: string }) =>
  transitionIssueStatus(
    { id: w.id, projectId: w.projectId, status: 'awaiting_release', reopenCount: 0 },
    'closed',
    { type: 'user', id: w.userId },
  );

async function statusOf(id: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${id}::uuid`,
  );
  return (rows[0] as { status: string }).status;
}

describe('the landing a tag was shown to hold is the landing the close is made on', () => {
  it('closes where nothing moved while the tags were read', async () => {
    const w = await seed();

    expect((await close(w)).status).toBe('closed');
  });

  it('refuses, as a stale transition, where the mark moved to another commit during the read', async () => {
    const w = await seed();
    whileReading = async () => {
      await harness.db.execute(
        sql`UPDATE issues SET merged_commit_sha = ${B} WHERE id = ${w.id}::uuid`,
      );
    };

    await expect(close(w)).rejects.toMatchObject({
      code: 'STALE_TRANSITION',
      details: { requires: 'releaseTag', judged: A },
    });
    expect(await statusOf(w.id)).toBe('awaiting_release');
  });

  it('refuses where the mark was cleared during the read and not made again', async () => {
    const w = await seed();
    whileReading = async () => {
      await harness.db.execute(
        sql`UPDATE issues SET merged_commit_sha = NULL WHERE id = ${w.id}::uuid`,
      );
    };

    await expect(close(w)).rejects.toMatchObject({ code: 'STALE_TRANSITION' });
    expect(await statusOf(w.id)).toBe('awaiting_release');
  });
});
