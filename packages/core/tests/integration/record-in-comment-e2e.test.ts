/**
 * ISS-1113 — a `forge-record` fence at the comment door, through the app's own route and a real
 * database. A caller that declared `record-route` is refused a fence in a comment and pointed at the
 * store its kind goes to; a caller that declared nothing has its record read and written as the
 * record it is (`issues/record-events/mirror.ts`), or refused by the rule it breaks — never stored
 * as a comment that silently carries no record. Every fence of a comment is read (ISS-608): several
 * verdict fences are all recorded, and a fence that cannot be read refuses the whole comment by name.
 *
 * @direct-test-of packages/core/src/issues/record-events/mirror.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_BODY_MAX_CHARS } from '../../src/comments/body-input.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
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
const PLAIN = 'The run judged criterion 3 and it passed. Nothing structured in this one.';

const fenced = (kind: string, judged: string | null = JUDGED): string =>
  [
    'Criterion 3 passed at the head the review judged.',
    '',
    `${FENCE}forge-record`,
    'criterion: 3',
    'verdict: pass',
    ...(judged ? [`commit: ${judged}`] : []),
    FENCE,
    '',
    `\`forge-record: ${kind} · contract 1\``,
  ].join('\n');

let issueId: string;
let jwt: string;

beforeEach(async () => {
  await truncateAll();
  const owner = await createTestUser({ verified: true });
  const project = await createTestProject(owner.id);
  await addProjectMember(project.id, owner.id, 'admin');
  const [issue] = await rows<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'record-target', ${owner.id})
    RETURNING id
  `);
  issueId = String(issue?.id);
  await replaceCriteria(
    issueId,
    [1, 2, 3].map((n) => ({ n, statement: `criterion ${n}` })),
  );
  jwt = await userToken(owner.id);
});

const capability = (capabilities?: string) =>
  capabilities === undefined ? {} : { 'x-forge-capabilities': capabilities };

const post = (body: string, capabilities?: string) =>
  api(
    jwt,
    'POST',
    `/api/issues/${issueId}/comments`,
    { body, intent: 'note' },
    capability(capabilities),
  );

const edit = (id: string, body: string, capabilities?: string) =>
  api(jwt, 'PATCH', `/api/comments/${id}`, { body }, capability(capabilities));

/** The rule a `MESSAGE_REFUSED` names in its sentence, read the way a caller reads it. */
function ruleOf(res: ApiResponse): string | null {
  return /\(rule ([\w-]+);/.exec(String(res.body.detail))?.[1] ?? null;
}

const warnings = (res: ApiResponse) => (res.body.warnings as string[] | undefined) ?? [];

async function stored(): Promise<{ comments: number; verdicts: number }> {
  const [count] = await rows<{ comments: number; verdicts: number }>(sql`
    SELECT (SELECT count(*)::int FROM comments WHERE issue_id = ${issueId}) AS comments,
           (SELECT count(*)::int FROM criterion_verdicts WHERE issue_id = ${issueId}) AS verdicts
  `);
  return { comments: Number(count?.comments), verdicts: Number(count?.verdicts) };
}

describe('a caller that declared it can write a record elsewhere', () => {
  it('is refused under the rule record-in-comment, pointed at the act that records a verdict, and nothing is written', async () => {
    const res = await post(fenced('verdict'), 'record-route');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGE_REFUSED');
    expect(ruleOf(res)).toBe('record-in-comment');
    expect(String(res.body.detail)).toContain(
      'a `verdict` record goes to `POST /api/issues/:id/verdicts`',
    );
    expect(String(res.body.detail)).toContain('records-and-comments');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('names the kind it was sent, whatever the kind', async () => {
    const res = await post(fenced('baseline'), 'record-route');
    expect(ruleOf(res)).toBe('record-in-comment');
    expect(String(res.body.detail)).toContain(
      'a `baseline` record goes to `POST /api/issues/:id/events`',
    );
  });

  it('is written for a body carrying no fence, with no record warning', async () => {
    const res = await post(PLAIN, 'record-route');
    expect(res.status).toBe(201);
    expect(warnings(res)).toEqual([]);
  });

  it('is refused a fence whose tag rides on the fence itself, the same way', async () => {
    const onTheFence = [
      'Criterion 3 passed.',
      '',
      `${FENCE}forge-record: verdict · contract 1`,
      'criterion: 3',
      'verdict: pass',
      `commit: ${JUDGED}`,
      FENCE,
    ].join('\n');
    const res = await post(onTheFence, 'record-route');
    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-in-comment');
  });
});

describe('a caller that declared nothing has its record read as a record', () => {
  it.each([
    ['no header', undefined],
    ['another capability', 'some-other-capability'],
    ['an empty header', ''],
  ])('writes the comment and the verdict it carries, with %s', async (_, header) => {
    const res = await post(fenced('verdict'), header);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored()).toEqual({ comments: 1, verdicts: 1 });
    const [verdict] = await rows<{ verdict: string; commit_sha: string }>(sql`
      SELECT v.verdict, v.commit_sha FROM criterion_verdicts v
        JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE v.issue_id = ${issueId} AND c.n = 3
    `);
    expect(verdict).toEqual({ verdict: 'pass', commit_sha: JUDGED });
  });

  it('refuses a verdict naming nothing it was judged against by that rule, and writes neither half', async () => {
    const res = await post(fenced('verdict', null));

    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('VERDICT_IDENTITY_REQUIRED');
    expect(String(res.body.detail)).toContain(
      "criterion 3's `pass` names nothing it was judged against",
    );
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('refuses a verdict on a criterion the issue does not carry', async () => {
    const res = await post(fenced('verdict').replace('criterion: 3', 'criterion: 9'));

    expect(res.status).toBe(422);
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });
});

describe('a fence that carries no record at all', () => {
  const unreadable = [`${FENCE}forge-record verdict`, 'criterion: 3', FENCE].join('\n');
  const neverClosed = [`${FENCE}forge-record`, 'criterion: 3', 'verdict: pass'].join('\n');

  it.each([
    ['with no capability declared', undefined],
    ['when the caller declares record-route', 'record-route'],
  ])('is refused under record-fence-shape %s', async (_, header) => {
    const res = await post(unreadable, header);
    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-shape');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('refuses a fence that is never closed', async () => {
    const res = await post(neverClosed);
    expect(res.status).toBe(422);
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('shows a shape that is valid rather than only naming what was wrong', async () => {
    const why = String((await post(unreadable)).body.detail);
    expect(why).toContain('records-and-comments');
    expect(why).toContain('either carries one or is told it does not');
    expect(why).toContain('for example: ```forge-record: verdict · contract 1');
  });
});

/** One verdict fence in the CLI's shape, the tag on a line after the close. */
const verdictFence = (n: number, judged = JUDGED): string[] => [
  `${FENCE}forge-record`,
  `criterion: ${n}`,
  'verdict: pass',
  `commit: ${judged}`,
  FENCE,
  '',
  '`forge-record: verdict · contract 1`',
  '',
];

async function verdictsByCriterion(): Promise<number[]> {
  const held = await rows<{ n: number }>(sql`
    SELECT c.n FROM criterion_verdicts v JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE v.issue_id = ${issueId} ORDER BY c.n
  `);
  return held.map((r) => Number(r.n));
}

describe('a comment carrying several record fences (ISS-608)', () => {
  it('records every verdict fence, not only the first', async () => {
    const body = ['Three criteria judged.', '', ...[1, 2, 3].flatMap((n) => verdictFence(n))].join(
      '\n',
    );
    const res = await post(body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(warnings(res).filter((w) => w.startsWith('VERDICT_RECORD_EMPTY'))).toEqual([]);
    expect(await verdictsByCriterion()).toEqual([1, 2, 3]);
  });

  it('records both shapes side by side in one comment', async () => {
    const onTheFence = [
      `${FENCE}forge-record: verdict · contract 1`,
      'criterion: 2',
      'verdict: pass',
      `commit: ${JUDGED}`,
      FENCE,
    ];
    const res = await post([...verdictFence(1), ...onTheFence].join('\n'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictsByCriterion()).toEqual([1, 2]);
  });

  it('refuses the whole comment naming the fence that is malformed, and records none of it', async () => {
    const bad = [`${FENCE}forge-record verdict`, 'criterion: 2', 'verdict: pass', FENCE];
    const res = await post([...verdictFence(1), ...bad, '', ...verdictFence(3)].join('\n'));

    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-shape');
    expect(String(res.body.detail)).toContain('fence 2 of 3');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('refuses the whole comment naming the fence whose verdict core refuses', async () => {
    const res = await post([...verdictFence(1), ...verdictFence(9)].join('\n'));

    expect(res.status).toBe(422);
    expect(String(res.body.detail)).toContain('fence 2 of 2');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('refuses a later fence that is never closed, naming it', async () => {
    const open = [`${FENCE}forge-record`, 'criterion: 2', 'verdict: pass'];
    const res = await post([...verdictFence(1), ...open].join('\n'));
    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-shape');
    expect(String(res.body.detail)).toContain('fence 2 of 2');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('refuses a verdict fence beside a record of another kind, naming the other one', async () => {
    const baseline = [
      `${FENCE}forge-record`,
      'gate: pnpm test',
      FENCE,
      '',
      '`forge-record: baseline · contract 1`',
    ];
    const res = await post([...verdictFence(1), ...baseline].join('\n'));

    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-several');
    expect(String(res.body.detail)).toContain('fence 2 of 2 is a `baseline` record');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('reads a fence quoted inside another fence as content, not as a second record', async () => {
    const quoted = ['````', ...verdictFence(2), '````'];
    const res = await post([...verdictFence(1), ...quoted].join('\n'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await verdictsByCriterion()).toEqual([1]);
  });
});

describe('a fence that names no kind (ISS-608)', () => {
  const kindless = [
    'Criterion 3 passed.',
    '',
    `${FENCE}forge-record`,
    'criterion: 3',
    'verdict: pass',
    `commit: ${JUDGED}`,
    FENCE,
  ].join('\n');

  it('is refused by name rather than stored as a verdict nobody reads', async () => {
    const res = await post(kindless);

    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-shape');
    expect(String(res.body.detail)).toContain('names no kind');
    expect(await stored()).toEqual({ comments: 0, verdicts: 0 });
  });

  it('is refused at the edit door the same way', async () => {
    const written = await post(PLAIN);
    const res = await edit(String(written.body.id), kindless);
    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-fence-shape');
  });
});

describe('the edit door is screened by the same rule', () => {
  it('refuses a declaring caller that edits a fence in, leaving the body as it was', async () => {
    const written = await post(PLAIN);
    const res = await edit(String(written.body.id), fenced('verdict'), 'record-route');

    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-in-comment');
    const [body] = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId}`,
    );
    expect(body?.body).toBe(PLAIN);
  });

  it('reads a record a non-declaring caller edits in, as the post door does', async () => {
    const written = await post(PLAIN);
    const res = await edit(String(written.body.id), fenced('verdict'));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await stored()).toEqual({ comments: 1, verdicts: 1 });
  });
});

describe('the character cap is not the lever', () => {
  it('leaves COMMENT_BODY_MAX_CHARS where ISS-1113 found it', () => {
    expect(COMMENT_BODY_MAX_CHARS).toBe(64_000);
  });

  it('writes a long body carrying no fence, whatever the caller declares', async () => {
    const long = `A long explanation somebody wanted. ${'reasoning '.repeat(400)}`;
    expect(long.length).toBeGreaterThan(4_000);
    expect((await post(long, 'record-route')).status).toBe(201);
  });

  it('refuses a body one character over the cap, naming the cap', async () => {
    const res = await post('x'.repeat(COMMENT_BODY_MAX_CHARS + 1));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(String(COMMENT_BODY_MAX_CHARS));
  });
});

describe('an indented block the body opens with', () => {
  const INDENTS = [' ', '  ', '   ', '    '];
  const blockAt = (indent: string): string =>
    [`${indent}${FENCE}forge-record`, `${indent}criterion: 3`, `${indent}${FENCE}`].join('\n');

  it('is written whatever the caller declared, and stored with the indent its author wrote', async () => {
    for (const indent of INDENTS) {
      for (const header of [undefined, 'record-route']) {
        const res = await post(blockAt(indent), header);
        expect(res.status, `${JSON.stringify(indent)} ${header}`).toBe(201);
        expect(warnings(res)).toEqual([]);
      }
    }
    const bodies = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at, id`,
    );
    expect(bodies.map((r) => r.body)).toEqual(INDENTS.flatMap((i) => [blockAt(i), blockAt(i)]));
  });

  it('is read as a record once the author moves it to the left margin', async () => {
    const res = await post(blockAt(''), 'record-route');
    expect(res.status).toBe(422);
    expect(ruleOf(res)).toBe('record-in-comment');
  });
});

describe('a body holding nothing but whitespace', () => {
  it('is refused saying so, rather than by a length the caller cannot see', async () => {
    const res = await post('   \n\t\n');
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain('whitespace only');
  });
});

// ISS-607: a decision's `until` ends it only on a date it names; the fence door says how it read one.
describe("a decision fence's until", () => {
  const decisionFence = (until: string) =>
    [
      `${FENCE}forge-record: decision · contract 1`,
      'decision: waits',
      'why: the release waits on production being declared',
      `until: ${until}`,
      FENCE,
    ].join('\n');

  it('is read as a condition where it names no date, and the comment answer says so', async () => {
    const res = await post(decisionFence('the owner admits or drops ISS-304'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(warnings(res).filter((w) => w.startsWith('DECISION_UNTIL_CONDITION'))).toEqual([
      expect.stringContaining('`the owner admits or drops ISS-304`'),
    ]);
  });

  it('warns of nothing for a date still to come', async () => {
    const res = await post(decisionFence('2999-01-01'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(warnings(res).filter((w) => w.startsWith('DECISION_UNTIL'))).toEqual([]);
  });
});
