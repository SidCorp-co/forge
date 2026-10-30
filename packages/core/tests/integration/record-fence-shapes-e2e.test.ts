/**
 * The two comment shapes adminhub-api's judges wrote on ISS-84 (comment 120c6062, 16 fences) and
 * ISS-83 (comment 3fda38cd, 5 fences), 2026-10-30, after which `forge resume` read no verdict:
 *
 * - several verdict fences, each tagged on its opening fence: every fence is recorded, all or
 *   nothing (ISS-608). Dev recorded all 16 and all 5 (`issue_record_events` carry the comment id);
 *   the reading of none was forge-plugin's (`docs/proposals/forge-plugin-reported.md`);
 * - the tag line written above its fence: refused whole, naming the line and where it goes. Before,
 *   a single such fence was refused as naming no kind, and with two the first fence silently took the
 *   second fence's marker as its own while the refusal named the second.
 *
 * @direct-test-of packages/core/src/messaging/forge-record.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const FENCE = '```';
const JUDGED = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';
const MARKER = '`forge-record: verdict · contract 1`';

let issueId: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestUser({ verified: true });
  const author = await createTestUser({ kind: 'agent' });
  const project = await createTestProject(owner.id);
  await addProjectMember(project.id, owner.id, 'admin');
  await addProjectMember(project.id, author.id, 'member');
  const [issue] = await rows<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'seeder cleanup', ${owner.id}) RETURNING id`);
  issueId = String(issue?.id);
  await rows(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, 1, 'one holds', 0), (${issueId}, 2, 'two holds', 1),
           (${issueId}, 3, 'three holds', 2)`);
  agent = await userToken(author.id);
});

const fields = (n: number) => [
  `criterion: ${n}`,
  'verdict: pass',
  `commit: ${JUDGED}`,
  'evidence: https://ci.example.test/runs/7',
];

const comment = (lines: string[]) =>
  api(agent, 'POST', `/api/issues/${issueId}/comments`, {
    body: ['Judged at the served head.', '', ...lines].join('\n'),
    intent: 'note',
  });

async function stored(): Promise<{ comments: number; verdicts: number[] }> {
  const [c] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}`,
  );
  const v = await rows<{ n: number }>(sql`
    SELECT c.n FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE v.issue_id = ${issueId} ORDER BY c.n`);
  return { comments: Number(c?.n), verdicts: v.map((r) => Number(r.n)) };
}

const detailOf = (res: ApiResponse) => String(res.body.detail);

describe('several verdict fences tagged on their opening fences (ISS-84 120c6062)', () => {
  it('records every fence of the comment', async () => {
    const res = await comment(
      [1, 2, 3].flatMap((n) => [
        `${FENCE}forge-record: verdict · contract 1`,
        ...fields(n),
        FENCE,
        '',
      ]),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored()).toEqual({ comments: 1, verdicts: [1, 2, 3] });
  });
});

describe('a tag line written above its fence', () => {
  it('refuses the comment, naming the line and where it goes, and stores nothing', async () => {
    const res = await comment([MARKER, `${FENCE}forge-record`, ...fields(1), FENCE]);
    expect(res.status).toBe(422);
    expect(detailOf(res)).toContain(
      'the tag line `forge-record: verdict · contract 1` sits above its `forge-record` fence, where no reader looks: it goes on the line after the closing fence, or on the opening fence itself',
    );
    expect(await stored()).toEqual({ comments: 0, verdicts: [] });
  });

  it('names the first fence where every fence has its marker above, not the last', async () => {
    const res = await comment([
      MARKER,
      `${FENCE}forge-record`,
      ...fields(1),
      FENCE,
      '',
      MARKER,
      `${FENCE}forge-record`,
      ...fields(2),
      FENCE,
    ]);
    expect(res.status).toBe(422);
    expect(detailOf(res)).toContain('fence 1 of 2: the tag line');
    expect(detailOf(res)).toContain('read as another record or as none');
    expect(await stored()).toEqual({ comments: 0, verdicts: [] });
  });

  it('still records fences each closed by its own tag line, one straight above the next fence', async () => {
    const res = await comment(
      [1, 2].flatMap((n) => [`${FENCE}forge-record`, ...fields(n), FENCE, MARKER]),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored()).toEqual({ comments: 1, verdicts: [1, 2] });
  });
});
