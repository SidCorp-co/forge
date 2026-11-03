/**
 * REQ-68 BC-6 (ISS-687): a person's web session routes a feedback item to a fix and names or titles
 * no issue. A triage on the `forge_auth` session cookie carrying `issue`, `createIssue.title` or
 * `createIssue.description` is refused FEEDBACK_ISSUE_ACT_FORBIDDEN at that field and writes nothing;
 * the web form's own `{ route: "issue", createIssue: {} }` is triaged, and an agent's token (the
 * master, a run) still names the issue that carries it.
 *
 * @direct-test-of packages/core/src/feedback/routes.ts
 * @direct-test-of packages/core/src/feedback/triage-person-gate.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let web: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

const ANSWERS = {
  criterion: 'none',
  severity: 'medium',
  reproduced: 'Saved twice, both cards gone.',
};

const fileBug = async (title: string) =>
  (
    ok(await as('POST', '/feedback', { kind: 'bug', title, screen: 'The board' }), 201)
      .feedback as Doc
  ).key as string;

const stateOf = async (fb: string) =>
  (ok(await as('GET', `/feedback/${fb}`)).feedback as Doc).status;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  const session = await signUserToken(ownerId);
  say = requester(app, { owner: session });
  // the web's door: the same person on the `forge_auth` session cookie, no bearer
  web = async (method, path, body) => {
    const res = await app.request(at(path), {
      method,
      headers: { cookie: `forge_auth=${session}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Doc };
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a person's triage names no issue", () => {
  it('refuses the web naming an issue key, at /issue, and writes nothing', async () => {
    const fb = await fileBug('The board loses its cards');
    const issue = ok(await as('POST', '/issues', { title: 'Save the cards' }), 201)
      .displayId as string;
    const before = await stateOf(fb);
    const res = await web('POST', `/feedback/${fb}/triage`, {
      route: 'issue',
      issue,
      answers: ANSWERS,
    });
    expect(res.status, JSON.stringify(res.json)).toBeGreaterThanOrEqual(400);
    expect(res.json.code).toBe('FEEDBACK_ISSUE_ACT_FORBIDDEN');
    const refusals = (res.json.error as Doc).refusals as Doc[];
    expect(refusals.map((r) => r.path)).toEqual(['/issue']);
    expect(await stateOf(fb)).toBe(before);
  });

  it('refuses the web titling or describing the issue, at each field', async () => {
    const fb = await fileBug('The board forgets its order');
    const res = await web('POST', `/feedback/${fb}/triage`, {
      route: 'issue',
      createIssue: { title: 'Keep the order', description: 'Sort by position.' },
      answers: ANSWERS,
    });
    expect(res.json.code).toBe('FEEDBACK_ISSUE_ACT_FORBIDDEN');
    const refusals = (res.json.error as Doc).refusals as Doc[];
    expect(refusals.map((r) => r.path)).toEqual(['/createIssue/title', '/createIssue/description']);
  });

  it("triages the web form's own route to a fix, naming no issue", async () => {
    const fb = await fileBug('The board drops a column');
    const res = await web('POST', `/feedback/${fb}/triage`, {
      route: 'issue',
      createIssue: {},
      answers: ANSWERS,
    });
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
    expect(await stateOf(fb)).toBe('triaged');
  });

  it("lets an agent's token name the issue and title the draft", async () => {
    const fb = await fileBug('The board hides a card');
    ok(
      await as('POST', `/feedback/${fb}/triage`, {
        route: 'issue',
        createIssue: { title: 'Show every card' },
        answers: ANSWERS,
      }),
    );
    expect(await stateOf(fb)).toBe('triaged');
  });
});
