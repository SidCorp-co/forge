/**
 * ISS-1198 — the incident, against real Postgres.
 *
 * A judging run wrote eighteen verdicts citing captures it had taken. The volume they sat on was
 * cleared mid-run and the captures for criteria 1 through 15 were destroyed. The verdicts survived
 * and went on citing them, reading exactly like verdicts whose evidence was intact.
 *
 * What is reproduced here is the consequence rather than the cause: the bytes are gone and the
 * record that cites them is not. The rows are removed the way the wipe removed the files — nothing
 * is cleaned away to make an assertion pass, and the same read is taken before and after so the
 * only thing that moved is whether the citation resolves.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  issuesWithUnearnedCriteria,
  unearnedCriteriaReports,
} from '../../src/issues/criteria-verdicts.js';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** The identity the issues seeded here record as serving them. */
const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';

function verdictBlock(criterion: number, verdict: string, cited: string[]): string {
  return [
    `criterion: ${criterion} — the screen cleared`,
    `verdict: ${verdict}`,
    `runtime: ${SERVING}`,
    ...cited.map((one) => `evidence: ${one}`),
    'judge: judge-1',
    'judge-from: asked',
  ].join('\n');
}

function verdictComment(blocks: string[]): string {
  return [
    '## Judged',
    '',
    '```forge-record',
    ...blocks,
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
}

describe('what a verdict cites, once the evidence is gone (ISS-1198)', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  let seq = 0;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await registerIntegrationsForTest();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    seq = 0;
  });

  async function insertIssue(criteria: string): Promise<string> {
    seq += 1;
    const id = randomUUID();
    const landing = JSON.stringify({ landing: { head: 'dce6f354c', deployment: SERVING } });
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                          acceptance_criteria, session_context)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${'testing'}, ${ownerId},
              ${criteria}, ${landing}::jsonb)
    `);
    return id;
  }

  async function postVerdict(issueId: string, body: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body)
      VALUES (${id}, ${issueId}, ${ownerId}, ${body})
    `);
    return id;
  }

  async function attachToIssue(issueId: string, name: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
      VALUES (${randomUUID()}, ${issueId}, ${ownerId}, ${name}, ${`uploads/${name}`},
              ${'image/png'}, ${1024})
    `);
  }

  async function attachToComment(commentId: string, name: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO comment_attachments (id, comment_id, uploader_id, name, path, mime, size)
      VALUES (${randomUUID()}, ${commentId}, ${ownerId}, ${name}, ${`uploads/${name}`},
              ${'image/png'}, ${1024})
    `);
  }

  async function commentCount(issueId: string): Promise<number> {
    const rows = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM comments WHERE issue_id = ${issueId}`,
    );
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  async function attachmentCount(issueId: string): Promise<number> {
    const rows = await harness.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM issue_attachments WHERE issue_id = ${issueId}`,
    );
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  it('reports nothing while the tracker still holds what the verdict cites', async () => {
    const issueId = await insertIssue('1. the screen clears.');
    await attachToIssue(issueId, 'c17-cleared.png');
    await postVerdict(issueId, verdictComment([verdictBlock(1, 'pass', ['c17-cleared.png'])]));

    const [report] = await unearnedCriteriaReports([issueId]);
    expect(report?.unearned).toEqual([]);
    expect(report?.broken).toEqual([]);
    expect(await issuesWithUnearnedCriteria([issueId])).toEqual([]);
  });

  it('reports the citation as dangling once the capture is gone, same verdict, same read', async () => {
    const issueId = await insertIssue('1. the screen clears.');
    await attachToIssue(issueId, 'c17-cleared.png');
    const commentId = await postVerdict(
      issueId,
      verdictComment([verdictBlock(1, 'pass', ['c17-cleared.png'])]),
    );

    const before = await unearnedCriteriaReports([issueId]);
    expect(before[0]?.broken).toEqual([]);

    // The wipe: the bytes and the row that stood for them go, the verdict does not.
    await harness.db.execute(sql`DELETE FROM issue_attachments WHERE issue_id = ${issueId}`);

    const [after] = await unearnedCriteriaReports([issueId]);
    expect(after?.broken).toEqual([
      { criterion: 1, unresolved: [{ cited: 'c17-cleared.png', standing: 'dangling' }] },
    ]);
    expect(after?.unearned[0]?.why).toContain('c17-cleared.png');
    expect(after?.unearned[0]?.why).toContain('names no attachment this issue holds');
    expect(await issuesWithUnearnedCriteria([issueId])).toEqual([issueId]);

    // The verdict itself is untouched: one comment, still saying `pass`.
    expect(await commentCount(issueId)).toBe(1);
    const stored = await harness.db.execute(sql`SELECT body FROM comments WHERE id = ${commentId}`);
    expect((stored as unknown as Array<{ body: string }>)[0]?.body).toContain('verdict: pass');
  });

  it('counts an attachment on the issue comment the same as one on the issue', async () => {
    const issueId = await insertIssue('1. the screen clears.');
    const commentId = await postVerdict(
      issueId,
      verdictComment([verdictBlock(1, 'pass', ['c16-en-confirm.png'])]),
    );
    const [dangling] = await unearnedCriteriaReports([issueId]);
    expect(dangling?.broken[0]?.unresolved[0]?.standing).toBe('dangling');

    await attachToComment(commentId, 'c16-en-confirm.png');
    const [held] = await unearnedCriteriaReports([issueId]);
    expect(held?.broken).toEqual([]);
    expect(held?.unearned).toEqual([]);
  });

  it('reports the fifteen whose captures went and leaves the three that survived', async () => {
    const criteria = Array.from({ length: 18 }, (_, i) => `${i + 1}. ok`).join('\n');
    const issueId = await insertIssue(criteria);
    for (let n = 16; n <= 18; n += 1) await attachToIssue(issueId, `c${n}.png`);
    await attachToIssue(issueId, 'qa-judging-log.md');
    await postVerdict(
      issueId,
      verdictComment(
        Array.from({ length: 18 }, (_, i) =>
          verdictBlock(i + 1, 'pass', [`c${i + 1}.png`, 'qa-judging-log.md']),
        ),
      ),
    );

    const [report] = await unearnedCriteriaReports([issueId]);
    expect(report?.broken.map((b) => b.criterion)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    expect(report?.unearned.map((c) => c.criterion)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    for (const broken of report?.broken ?? []) {
      expect(broken.unresolved).toEqual([
        { cited: `c${broken.criterion}.png`, standing: 'dangling' },
      ]);
    }
  });

  it('adds no attachment row and removes none while reading', async () => {
    const issueId = await insertIssue('1. ok');
    await attachToIssue(issueId, 'c17-cleared.png');
    await postVerdict(issueId, verdictComment([verdictBlock(1, 'pass', ['c17-cleared.png'])]));

    const before = await attachmentCount(issueId);
    await unearnedCriteriaReports([issueId]);
    await issuesWithUnearnedCriteria([issueId]);
    expect(await attachmentCount(issueId)).toBe(before);
    expect(await commentCount(issueId)).toBe(1);
  });
});
