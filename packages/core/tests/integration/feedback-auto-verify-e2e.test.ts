/**
 * Anyone confirms a fix, and Forge confirms it for them when nobody does (owner, 2026-10-07): any
 * member may verify a resolved item and the decision names them; a sweep dates the first time an item
 * reads resolved, verifies it by the system once the project's window has run, tells its reporter
 * once, and leaves an item still inside its window alone; the BA's Needs you holds no verify row.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { ago, feedback, issue, world } from '../helpers/forecast-world.js';

type Who = 'owner' | 'ann' | 'bo';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const people = {} as Record<Who, string>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const seq = (fb: string) => Number(fb.slice(3));

/** An item reported by `who`, answered by a triager: it reads resolved at once. */
async function resolved(who: Who, title: string): Promise<string> {
  const fb = ok(
    await say(who, 'POST', at('/feedback'), {
      kind: 'question',
      title,
      screen: '/projects/hop/board',
    }),
    201,
  ).feedback.key as string;
  ok(
    await say('owner', 'POST', item(fb, 'triage'), { route: 'answer', answer: 'It is by design.' }),
  );
  return fb;
}

const read = async (fb: string, who: Who = 'owner'): Promise<Doc> =>
  ok(await say(who, 'GET', item(fb))).feedback;

const bell = async (who: Who) => {
  await settleOutbox();
  return (await db.execute(sql`
    SELECT n.title, n.body
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${people[who]} AND n.type = 'feedback_message' AND n.project_id = ${projectId}
     ORDER BY n.created_at
  `)) as unknown as { title: string; body: string }[];
};

async function seen(fb: string, daysAgo: number) {
  await db.execute(sql`
    UPDATE feedback SET resolved_seen_at = now() - make_interval(days => ${daysAgo})
     WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}
  `);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann', 'bo'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.ann, 'member');
  await addProjectMember(projectId, people.bo, 'member');
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('any member confirms a fix, and the record says who and when', () => {
  it('lets a member who is neither reporter nor approver verify, and names them', async () => {
    const fb = await resolved('ann', 'Why is the board read-only?');
    expect((await read(fb, 'bo')).can).toMatchObject({ verify: true });
    const out = ok(await say('bo', 'POST', item(fb, 'verify'), {})).feedback;
    expect(out.status).toBe('verified');
    expect(out.verified).toMatchObject({ how: 'person', by: people.bo, byReporter: false });
    expect((out.verified as Doc).at).toBeTruthy();
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      decidedBy: people.bo,
      decidedAgency: 'human',
    });
  });

  it('keeps an item whose fix shipped off the triager’s Needs you: nobody is owed the act', async () => {
    const w = await world();
    const carrier = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
    const fb = await feedback(w, [carrier.id]);
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/feedback/${fb}`);
    const r = res.body.feedback as Doc;
    expect(r.phase).toBe('resolved');
    expect(r.attentionGroup, 'no verify row on Needs you').not.toBe('needs_you');
    expect(r.waitingOn).not.toMatchObject({ kind: 'you' });
  });
});

describe('Forge verifies an item nobody confirmed, once its window has run', () => {
  it('dates the first sighting, then verifies by the system past the window, and tells the reporter once', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Is the export meant to skip blanks?');
    const first = await sweepResolvedFeedback();
    expect(first.dated).toBeGreaterThanOrEqual(1);
    const dated = await read(fb);
    expect(dated.status).toBe('triaged');
    expect(dated.autoVerify).toMatchObject({ windowDays: 7 });

    await seen(fb, 8);
    const before = (await bell('ann')).length;
    expect((await sweepResolvedFeedback()).verified).toBe(1);
    const out = await read(fb);
    expect(out.status).toBe('verified');
    expect(out.verified).toMatchObject({
      how: 'automatic',
      by: null,
      reason: 'Verified automatically after 7 days with no reply',
    });
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({
      decision: 'verified',
      decidedBy: null,
      decidedAgency: 'system',
    });
    const notices = (await bell('ann')).slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain('Verified automatically after 7 days with no reply');
    expect((await sweepResolvedFeedback()).verified, 'a verified item is not verified twice').toBe(
      0,
    );
  });

  it('leaves an item still inside its window, however recently it was last swept', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Why does the badge say Planned?');
    await sweepResolvedFeedback();
    await seen(fb, 6);
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('triaged');
    expect((await bell('ann')).some((n) => n.title.includes(fb))).toBe(false);
  });

  it('counts from the project’s own window, and a reopened item starts over', async () => {
    const { sweepResolvedFeedback } = await import('../../src/feedback/index.js');
    const fb = await resolved('ann', 'Reopen me before the window ends');
    await sweepResolvedFeedback();
    await seen(fb, 5);
    ok(await say('ann', 'POST', item(fb, 'reopen'), { reason: 'It is not fixed.' }));
    await sweepResolvedFeedback();
    expect((await read(fb)).status).toBe('reopened');
    const stamp = (await db.execute(
      sql`SELECT resolved_seen_at FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq(fb)}`,
    )) as unknown as { resolved_seen_at: Date | null }[];
    expect(
      stamp[0]?.resolved_seen_at,
      'a reopen clears the date the window counts from',
    ).toBeNull();
  });
});
