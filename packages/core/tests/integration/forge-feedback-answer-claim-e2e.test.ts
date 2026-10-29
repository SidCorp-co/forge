/**
 * REQ-47 r2 BC-11 (ISS-748): an answer to an item of feedback about Forge reaches its reporter's own
 * session once. `POST /api/forge/feedback/answers/claim` hands the caller the answers on its own items
 * none of its sessions was told, records each as told in the same act, and hands nothing of another
 * account's; the forge-runner hook asks it on a session's prompt and injects what it answers.
 *
 * Planted from forge-dev on 2026-10-29: core kept no record of which answers a reporter had been told,
 * so the hook had nothing to ask and a reporter only learned of an answer by reading the item.
 *
 * @direct-test-of packages/core/src/feedback/answers-told.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 * @direct-test-of packages/core/src/forge-door/routes.ts
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

let w: World;
/** The reporter, an agent working in a project of its own; `repeat` reports one of its items again. */
const pats = { reporter: '', repeat: '', stranger: '' };

interface Claimed {
  key: string;
  answer: string;
  answeredAt: string;
}

const at = (path: string) => `/api/projects/${w.projectId}${path}`;

async function claim(pat: string): Promise<Claimed[]> {
  const res = await api(pat, 'POST', '/api/forge/feedback/answers/claim', {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const answers = res.body.answers as Claimed[];
  expect(res.body.returned).toBe(answers.length);
  return answers;
}

async function filed(title: string, pat = pats.reporter, signalKey?: string): Promise<string> {
  const res = await api(pat, 'POST', '/api/forge/feedback', {
    kind: 'question',
    title,
    whereSeen: 'command forge claim --next',
    ...(signalKey ? { signalKey } : {}),
  });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return (res.body.feedback as Body).key as string;
}

async function triage(key: string, body: Record<string, unknown>) {
  // a decline is an act and asks no checklist questions
  const asked = body.route === 'decline' ? {} : { answers: TRIAGE_ANSWERS };
  const res = await api(w.token, 'POST', at(`/feedback/${key}/triage`), { ...asked, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function answered(title: string, answer: string): Promise<string> {
  const key = await filed(title);
  await triage(key, { route: 'answer', answer });
  return key;
}

const mine = (claimed: Claimed[], key: string) => claimed.filter((c) => c.key === key);

beforeAll(async () => {
  testEnv();
  w = await world();
  const client = (await createTestProject(w.userId)).id;
  const pat = async (userId: string) =>
    (
      await mintPat({
        permissions: ['*'],
        userId,
        name: 'box',
        projectIds: [client],
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
  for (const who of ['reporter', 'repeat', 'stranger'] as const) {
    const id = (await createTestUser({ kind: 'agent' })).id;
    // no member of the home project: a reporter reads its own items through the door (REQ-47 BC-3)
    await addProjectMember(client, id);
    pats[who] = await pat(id);
  }
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${w.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${w.projectId}
  `);
  // every claim below starts from nothing owed: answers an earlier test of this file gave are told
  await claim(pats.reporter);
}, 120_000);

describe('an answer reaches its reporter once (REQ-47 BC-11)', () => {
  it("hands the reporter the item's key and the answer's text, as the item reads it", async () => {
    const key = await answered('Why is the board sorted by rank?', 'By design: rank, not age.');
    const claimed = await claim(pats.reporter);
    expect(mine(claimed, key)).toEqual([
      { key, answer: 'By design: rank, not age.', answeredAt: expect.any(String) },
    ]);
    const read = await api(pats.reporter, 'GET', `/api/forge/feedback/${key}`);
    expect((read.body.told as Body).answer).toBe('By design: rank, not age.');
  });

  it('hands a told answer to no later claim, from the same account', async () => {
    const key = await answered('Told once?', 'Once.');
    expect(mine(await claim(pats.reporter), key)).toHaveLength(1);
    expect(mine(await claim(pats.reporter), key)).toEqual([]);
    expect(await claim(pats.reporter)).toEqual([]);
  });

  it('hands a later answer on the same item once, after the reply it answers', async () => {
    const key = await answered('Answered twice?', 'First answer.');
    expect(mine(await claim(pats.reporter), key).map((c) => c.answer)).toEqual(['First answer.']);
    const replied = await api(pats.reporter, 'POST', `/api/forge/feedback/${key}/reply`, {
      evidence: 'The first answer does not cover the CLI.',
    });
    expect(replied.status, JSON.stringify(replied.body)).toBe(200);
    // the reply took the answer back: nothing stands to tell until the next one
    expect(mine(await claim(pats.reporter), key)).toEqual([]);
    const detail = await api(w.token, 'GET', at(`/feedback/${key}`));
    const standing = ((detail.body.feedback as Body).decisions as { id: string }[]).at(-1)?.id;
    await triage(key, { route: 'answer', answer: 'Second answer.', inReplyTo: standing });
    expect(mine(await claim(pats.reporter), key).map((c) => c.answer)).toEqual(['Second answer.']);
    expect(mine(await claim(pats.reporter), key)).toEqual([]);
  });

  it('hands two sessions claiming at once the answer one time between them', async () => {
    const key = await answered('Raced?', 'Exactly once.');
    const both = await Promise.all([claim(pats.reporter), claim(pats.reporter)]);
    expect(both.flatMap((c) => mine(c, key))).toHaveLength(1);
  });

  it('tells nothing of an item routed anywhere but an answer', async () => {
    const declined = await filed('Raise the limit?');
    await triage(declined, { route: 'decline', note: 'The host owns that limit.' });
    const untriaged = await filed('Never triaged');
    const claimed = await claim(pats.reporter);
    expect([...mine(claimed, declined), ...mine(claimed, untriaged)]).toEqual([]);
  });
});

describe("only the reporting account's sessions are told (REQ-47 BC-11)", () => {
  it("hands another account nothing of the reporter's answer, and leaves it owed to the reporter", async () => {
    await claim(pats.stranger);
    const key = await answered('Is this mine alone?', 'Yours alone.');
    expect(mine(await claim(pats.stranger), key)).toEqual([]);
    expect(mine(await claim(pats.reporter), key).map((c) => c.answer)).toEqual(['Yours alone.']);
  });

  it("tells a repeat's reporter the answer on its own account, once", async () => {
    const signal = 'iss748:repeat';
    const key = await filed('Reported twice', pats.reporter, signal);
    expect(await filed('Reported twice', pats.repeat, signal)).toBe(key);
    await triage(key, { route: 'answer', answer: 'For both of you.' });
    expect(mine(await claim(pats.reporter), key)).toHaveLength(1);
    expect(mine(await claim(pats.repeat), key).map((c) => c.answer)).toEqual(['For both of you.']);
    expect(mine(await claim(pats.repeat), key)).toEqual([]);
  });
});

describe('the claim refuses what it does not read (REQ-47 BC-11)', () => {
  it('refuses a body naming any field, by name, and hands nothing out', async () => {
    const key = await answered('Strict body?', 'Strict.');
    const res = await api(pats.reporter, 'POST', '/api/forge/feedback/answers/claim', {
      since: '2026-10-29',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('since');
    expect(mine(await claim(pats.reporter), key)).toHaveLength(1);
  });

  it('refuses a caller with no credential', async () => {
    expect((await api(null, 'POST', '/api/forge/feedback/answers/claim', {})).status).toBe(401);
  });
});

describe('answers given before answers reached sessions (migration 0549)', () => {
  it('records each as told by no session, so a first prompt is handed no backlog', async () => {
    const key = await answered('Answered before the hook existed', 'Old answer.');
    const file = new URL(
      '../../drizzle/migrations/0549_an_answer_reaches_the_reporter_session_once.sql',
      import.meta.url,
    );
    const backfill = readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.startsWith('INSERT INTO "feedback_answer_deliveries"'));
    expect(backfill, 'the migration backfills nothing').toBeDefined();
    await db.execute(sql.raw(backfill ?? ''));
    const via = await db.execute(sql`
      SELECT d.via FROM feedback_answer_deliveries d
      JOIN feedback_decisions x ON x.id = d.decision_id
      JOIN feedback f ON f.id = x.feedback_id
      WHERE f.project_id = ${w.projectId} AND 'FB-' || f.fb_seq = ${key}
    `);
    expect(via.map((r) => r.via)).toEqual(['predates']);
    expect(mine(await claim(pats.reporter), key)).toEqual([]);
  });
});
