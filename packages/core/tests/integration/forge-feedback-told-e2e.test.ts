/**
 * REQ-47 BC-10 (ISS-746): what triage tells a reporter is readable by that reporter at the item, through
 * the door they filed by — the answer, the decline's reason, the clarification asked and the release the
 * fix shipped in — in the words the project's own read gives, and nothing else of the item's record.
 * BC-1: filing through the Forge door, over REST and forge_feedback, answers the item's FB key.
 *
 * Planted from forge-dev on 2026-10-29: FB-333, filed by an agent through the Forge door and triaged
 * route=answer, read `route: { route: answer, carriers: [] }` and no answer, so its reporter reopened it
 * twice to ask what the answer was.
 *
 * @direct-test-of packages/core/src/feedback/told.ts
 * @direct-test-of packages/core/src/forge-door/reads.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let w: World;
/** The reporter: an agent working in a project of its own, no member of the home project (BC-3). */
const reporter = { id: '', pat: '' };
/** A second reporter of the answered item, by a later report of its signal key. */
const other = { id: '', pat: '', name: 'second-reporter-iss746' };
const INTERNAL = 'INTERNAL-ISS746: members only, never the reporter';
const ANSWER = 'It is by design: the board sorts by rank, not by age.';
const DECLINE = 'Not ours to change: the host owns that limit.';
const ASK = {
  prompt: 'Which command did you run when it failed?',
  needed: 'The command and its output',
  recommended: 'forge claim --next',
};
const keys = { answered: '', declined: '', clarified: '', shipped: '', silent: '' };

const home = (path: string) => `/api/projects/${w.projectId}${path}`;

async function callTool(token: string, args: Record<string, unknown>) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_feedback', arguments: args },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content[0]?.text ?? '';
  expect(result.isError === true, text).toBe(false);
  return JSON.parse(text) as Body;
}

/** Files one report through the Forge door's REST route, as `pat`; answers the body. */
async function fileRest(pat: string, title: string, signalKey?: string) {
  return api(pat, 'POST', '/api/forge/feedback', {
    kind: 'question',
    title,
    whereSeen: 'command forge claim --next',
    ...(signalKey ? { signalKey } : {}),
  });
}

const storedKey = async (title: string) =>
  (
    await rows<{ key: string }>(
      sql`SELECT 'FB-' || fb_seq AS key FROM feedback WHERE title = ${title}`,
    )
  )[0]?.key;

async function filed(title: string): Promise<string> {
  const res = await fileRest(reporter.pat, title);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.feedback as Body).key as string;
}

async function ok(res: { status: number; body: Body }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

async function projectDetail(key: string): Promise<Body> {
  return (await ok(await api(w.token, 'GET', home(`/feedback/${key}`)))).feedback as Body;
}

async function doorItem(key: string, pat = reporter.pat): Promise<Body> {
  return ok(await api(pat, 'GET', `/api/forge/feedback/${key}`));
}

beforeAll(async () => {
  w = await world();
  const client = await createTestProject(w.userId);
  const mint = async (userId: string, name: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId,
        name,
        projectIds: [client.id],
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
  reporter.id = (await createTestUser({ kind: 'agent' })).id;
  other.id = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE users SET display_name = ${other.name} WHERE id = ${other.id}`);
  for (const id of [reporter.id, other.id]) await addProjectMember(client.id, id);
  reporter.pat = await mint(reporter.id, 'reporter box');
  other.pat = await mint(other.id, 'other box');
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${w.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${w.projectId}
  `);

  // answered, with an internal note and a second reporter beside the answer
  const answeredTitle = 'Why does the board not sort by age?';
  const first = await fileRest(reporter.pat, answeredTitle, 'iss746:board-sort');
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  keys.answered = (first.body.feedback as Body).key as string;
  const again = await fileRest(other.pat, answeredTitle, 'iss746:board-sort');
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  await ok(
    await api(w.token, 'POST', home(`/feedback/${keys.answered}/messages`), {
      audience: 'internal',
      text: INTERNAL,
    }),
    201,
  );
  await ok(
    await api(w.token, 'POST', home(`/feedback/${keys.answered}/triage`), {
      answers: TRIAGE_ANSWERS,
      route: 'answer',
      answer: ANSWER,
    }),
  );

  keys.declined = await filed('Raise the upload limit to 2 GB');
  await ok(
    await api(w.token, 'POST', home(`/feedback/${keys.declined}/triage`), {
      route: 'decline',
      note: DECLINE,
    }),
  );

  keys.clarified = await filed('forge claim fails sometimes');
  await ok(await api(w.token, 'POST', home(`/feedback/${keys.clarified}/clarification`), ASK));

  // shipped: the reporter's item, routed onto an issue that closed and was cut into release 0.9.46
  const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  keys.shipped = await createTestFeedback(w.projectId, reporter.id, 900, [carrier.id]);
  await db.execute(sql`
    UPDATE feedback SET reporter_agency = 'agent' WHERE project_id = ${w.projectId} AND fb_seq = 900
  `);
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
    VALUES (${runId}, ${w.projectId}, 'system', 'completed', now(), '0.9.46', now(), ${JSON.stringify({ issueIds: [carrier.id] })}::jsonb)
  `);
  await db.execute(sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${carrier.id}`);

  keys.silent = await filed('Nothing told yet');
}, 120_000);

describe('filing through the Forge door answers the FB key (REQ-47 BC-1)', () => {
  it('answers it over REST, the key of the item stored', async () => {
    const title = 'REST filing answers its key';
    const res = await fileRest(reporter.pat, title);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const key = (res.body.feedback as Body).key;
    expect(key).toMatch(/^FB-\d+$/);
    expect(key).toBe(await storedKey(title));
  });

  it('answers it over forge_feedback submit, the key of the item stored', async () => {
    const title = 'MCP filing answers its key';
    const body = await callTool(reporter.pat, {
      action: 'submit',
      kind: 'question',
      title,
      target: { kind: 'command', ref: 'forge claim --next' },
    });
    expect(body.created).toBe(true);
    const key = (body.feedback as Body).key;
    expect(key).toMatch(/^FB-\d+$/);
    expect(key).toBe(await storedKey(title));
  });
});

describe('the reporter reads at the item what its triage told them (REQ-47 BC-10)', () => {
  it('reads the answer, in the words the project read gives', async () => {
    const told = (await doorItem(keys.answered)).told as Body;
    expect(told).toMatchObject({ answer: ANSWER, declined: null, shippedIn: null });
    expect(told.answer).toBe(((await projectDetail(keys.answered)).route as Body).answer);
  });

  it('reads the decline note, in the words the project read gives', async () => {
    const told = (await doorItem(keys.declined)).told as Body;
    expect(told).toMatchObject({ answer: null, declined: DECLINE });
    const decisions = (await projectDetail(keys.declined)).decisions as Body[];
    expect(told.declined).toBe(decisions.filter((d) => d.decision === 'declined').at(-1)?.reason);
  });

  it('reads the clarification asked, with the answer recommended, as the project read gives it', async () => {
    const told = (await doorItem(keys.clarified)).told as Body;
    expect(told.clarification).toEqual({
      prompt: ASK.prompt,
      recommended: ASK.recommended,
      status: 'open',
    });
    const asked = (await projectDetail(keys.clarified)).clarification as Body;
    expect(told.clarification).toEqual({
      prompt: asked.prompt,
      recommended: asked.recommended,
      status: asked.status,
    });
  });

  it('reads the release its fix shipped in, as the project read gives it', async () => {
    const told = (await doorItem(keys.shipped)).told as Body;
    expect(told.shippedIn).toBe('0.9.46');
    const notice = (await projectDetail(keys.shipped)).shipNotice as Body;
    expect(told.shippedIn).toBe((notice.shipped as Body).release);
  });

  it('reads nothing told on an item triage has not answered', async () => {
    expect((await doorItem(keys.silent)).told).toEqual({
      answer: null,
      declined: null,
      clarification: null,
      shippedIn: null,
    });
  });

  it('reads the same in its own list and over forge_feedback get', async () => {
    const list = await ok(await api(reporter.pat, 'GET', '/api/forge/feedback'));
    const listed = (list.feedback as Body[]).find((f) => f.key === keys.answered);
    const tool = await callTool(reporter.pat, { action: 'get', feedback: keys.answered });
    const one = await doorItem(keys.answered);
    expect(one.told).toMatchObject({ answer: ANSWER });
    expect(listed?.told).toEqual(one.told);
    expect(tool.told).toEqual(one.told);
  });

  it('reads it as the second reporter of the item too', async () => {
    expect(((await doorItem(keys.answered, other.pat)).told as Body).answer).toBe(ANSWER);
  });
});

describe('the door shows the reporter only what triage told them (REQ-47 BC-10)', () => {
  it('carries no internal note and no other reporter', async () => {
    const said = JSON.stringify(await doorItem(keys.answered));
    expect(said).not.toContain(INTERNAL);
    expect(said).not.toContain(other.name);
    expect(said).not.toContain(other.id);
  });

  it('carries no question id and no reporter answer in the clarification', async () => {
    const told = (await doorItem(keys.clarified)).told as Body;
    expect(Object.keys(told).sort()).toEqual(['answer', 'clarification', 'declined', 'shippedIn']);
    expect(Object.keys(told.clarification as Body).sort()).toEqual([
      'prompt',
      'recommended',
      'status',
    ]);
  });
});
