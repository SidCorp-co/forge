/**
 * Delivery starts only from a requirement the agent has checked, and its questions are asked on it
 * (REQ-67, ISS-688). The move into delivery is refused while the steward has not finished its check
 * since the head was agreed, and while a question about the requirement stands open; a gap Forge
 * sees refuses nothing of its own (owner rulings 2026-10-31, 2026-11-01: it goes back as a question,
 * owed by the master, never a canned list). A question delivery raises on an issue that delivers a
 * requirement names it, and its answer is recorded there as a decision.
 *
 * @direct-test-of packages/core/src/requirements/delivery-check.ts
 * @direct-test-of packages/core/src/requirements/acceptance.ts
 * @direct-test-of packages/core/src/questions/about-feedback.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { stewardChecked } from '../helpers/steward-checked.js';

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
/** The project's master: an agent account, as a delivery run or the master asks. */
let master: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let ownerId = '';
let req = '';
let issueId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;

const OPTIONS = [
  {
    id: 'keep',
    label: 'Keep every card',
    authority: 'writer',
    bindsTo: 'session',
    executedBy: 'agent',
  },
  {
    id: 'trim',
    label: 'Keep the last ten',
    authority: 'writer',
    bindsTo: 'session',
    executedBy: 'agent',
  },
];

const codesOf = (r: Reply) =>
  ((r.json.error?.refusals ?? []) as { code: string; path: string }[]).map((x) => [x.code, x.path]);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  const pat = await mintPat({
    permissions: ['*'],
    userId: agentId,
    name: 'master',
    projectIds: [projectId],
  });
  const as = requester(app, { owner: await signUserToken(ownerId), master: pat.plaintext });
  say = (method, path, body) =>
    as('owner', method, path.startsWith('/api/') ? path : at(path), body);
  master = (method, path, body) =>
    as('master', method, path.startsWith('/api/') ? path : at(path), body);

  req = ok(
    await say('POST', '/requirements', {
      title: 'The board keeps its cards',
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(req.slice(4)), ownerId);
  ok(await say('POST', `/requirements/${req}/revisions/1/propose`, {}));
  ok(await say('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await say('POST', `/requirements/${req}/agree`, { revision: 1, reason: 'owner signed r1' }));
  const proposed = ok(
    await say('POST', '/suggestions', {
      kind: 'breakdown',
      requirement: req,
      baseRevision: 1,
      payload: {
        issues: [
          {
            title: 'Save every card',
            criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
            complexity: 's',
            builds: null,
          },
        ],
      },
    }),
    201,
  );
  ok(await say('POST', `/suggestions/${proposed.suggestion.id}/accept`, { reason: 'one slice' }));
  const [filed] = await rows<{ id: string }>(
    sql`SELECT id FROM issues WHERE project_id = ${projectId} AND requirement_id IS NOT NULL`,
  );
  if (!filed) throw new Error('the breakdown accept filed no issue');
  issueId = filed.id;
  await settleOutbox();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a requirement whose delivery has not been checked', () => {
  it('is refused before the steward checked it, by name, and its read says why', async () => {
    const refused = await say('POST', `/requirements/${req}/start-delivery`, {});
    expect(refused.status).toBe(422);
    expect(codesOf(refused)).toEqual([['REQUIREMENT_UNCHECKED', '']]);
    const read = ok(await say('GET', `/requirements/${req}`));
    expect(read.deliveryCheck).toMatchObject({ owed: true, checkedAt: null, clear: false });
  });

  it('refuses a question delivery raises on its issue that names no item, and takes one that does', async () => {
    const question = {
      issueId,
      prompt: 'How many cards does a saved board keep?',
      options: OPTIONS,
      recommendedOptionId: 'keep',
      blockerKind: 'master_or_peer',
    };
    const bare = await master('POST', '/api/questions', question);
    expect(bare.status).toBe(422);
    expect(codesOf(bare)).toEqual([['QUESTION_ABOUT_REQUIRED', '/about']]);
    expect(JSON.stringify(bare.json)).toContain(`delivers ${req}`);
    const asked = await master('POST', '/api/questions', {
      ...question,
      about: { requirement: null },
    });
    expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  });

  it('leaves a person asking on the issue free to name nothing: the rule is for what delivery raises', async () => {
    const theirs = await say('POST', '/api/questions', {
      issueId,
      prompt: 'Which customer saw this first?',
      options: OPTIONS,
      recommendedOptionId: 'keep',
      blockerKind: 'master_or_peer',
    });
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(201);
    ok(
      await say('POST', `/api/questions/${theirs.json.id as string}/void`, {
        reason: 'answered in the thread',
      }),
    );
  });

  it('once checked, is refused while that question stands open, naming it', async () => {
    await stewardChecked(projectId, req);
    const [open] = await rows<{ id: string }>(
      sql`SELECT id FROM agent_questions WHERE project_id = ${projectId} AND status = 'open'`,
    );
    // the person's own question names no requirement, so it holds nothing
    const refused = await say('POST', `/requirements/${req}/start-delivery`, {});
    expect(refused.status).toBe(422);
    expect(codesOf(refused)).toEqual([['REQUIREMENT_QUESTION_OPEN', `/questions/${open?.id}`]]);
  });

  it('starts once the master answers, the answer recorded on the requirement as a decision', async () => {
    const [open] = await rows<{ id: string }>(
      sql`SELECT id FROM agent_questions WHERE project_id = ${projectId} AND status = 'open'`,
    );
    ok(await say('POST', `/api/questions/${open?.id}/answer`, { round: 1, optionId: 'keep' }));
    const read = ok(await say('GET', `/requirements/${req}`));
    expect(read.deliveryCheck).toMatchObject({ owed: true, questions: [], clear: true });
    const moved = await say('POST', `/requirements/${req}/start-delivery`, {});
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const decisions = await rows<{ body: string }>(
      sql`SELECT c.body FROM comments c JOIN requirements r ON r.id = c.requirement_id
           WHERE r.project_id = ${projectId} AND c.intent = 'decision'`,
    );
    expect(decisions.map((d) => d.body).join('\n')).toContain('How many cards');
  });
});
