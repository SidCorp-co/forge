/**
 * ISS-1229 r12 — the project health read counts each issue a stuck-issue notice stands for once,
 * whichever sweep raised it, and names the longest-standing first.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let readHealthAggregates: typeof import('../../src/projects/health-aggregates.js')['readHealthAggregates'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  readHealthAggregates = (await import('../../src/projects/health-aggregates.js'))
    .readHealthAggregates;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('the stuck issues of a project, as the health read counts them', () => {
  it('counts an issue once however many notices stand for it, and leaves out what is not firing', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issue = async (seq: number) => {
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq)
        VALUES (${id}::uuid, ${project.id}::uuid, 'stuck', 'open', ${user.id}::uuid, ${seq})
      `);
      return id;
    };
    const notice = async (
      issueId: string,
      suffix: string,
      state: string,
      minutesAgo: number,
      resolved = false,
    ) =>
      harness.db.execute(sql`
        INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                                   created_at, resolved_at)
        VALUES (${project.id}::uuid, ${issueId}::uuid, 'issue_stranded', 'condition', 'ticket', ${state},
                'stuck', ${`issue:${issueId}${suffix}`}, now() - (${minutesAgo} || ' minutes')::interval,
                ${resolved ? sql`now()` : sql`NULL`})
      `);
    const [older, newer, pendingOnly, resolvedOnly] = [
      await issue(1),
      await issue(2),
      await issue(3),
      await issue(4),
    ];
    await notice(newer, ':idle', 'firing', 5);
    await notice(older, ':idle', 'firing', 30);
    await notice(older, ':owed-close', 'firing', 20);
    await notice(pendingOnly, ':idle', 'pending', 40);
    await notice(resolvedOnly, ':idle', 'resolved', 50, true);

    const { stuckIssueRows } = await readHealthAggregates([project.id]);

    expect(stuckIssueRows.map((r) => ({ id: r.id, seq: r.issSeq, total: r.total }))).toEqual([
      { id: older, seq: 1, total: 2 },
      { id: newer, seq: 2, total: 2 },
    ]);
  });
});
