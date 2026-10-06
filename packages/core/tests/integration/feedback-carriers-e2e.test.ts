/**
 * An issue route names one or more carriers (ISS-265): an item delivered by several issues names every
 * one, each carrier lists it, and its phase and waiting-on read all of them.
 */

import { sql } from 'drizzle-orm';
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
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';

type Who = 'owner' | 'member';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let providerId = '';
let requirementKey = '';
type Issue = { id: string; key: string };

const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return { code: first.code, path: first.path, detail: first.detail };
}

async function file(title: string): Promise<string> {
  const made = ok(
    await say('member', 'POST', at('/feedback'), { kind: 'bug', title, screen: 'The board' }),
    201,
  );
  return made.feedback.key as string;
}

async function issue(title: string): Promise<Issue> {
  const made = ok(await say('owner', 'POST', at('/issues'), { title }), 201);
  return { id: made.id, key: made.displayId };
}

const read = async (fb: string): Promise<Doc> => ok(await say('owner', 'GET', item(fb))).feedback;

async function waitingOn(fb: string): Promise<Doc> {
  const list = ok(await say('member', 'GET', at('/feedback')));
  return list.feedback.find((f: Doc) => f.key === fb).waitingOn;
}

/** A carrier that shipped: `closed` follows a merge mark (ISS-1108), so both are seeded. */
async function ship(issueId: string): Promise<void> {
  await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${issueId}`);
  await seedIssueStatus(issueId, 'closed');
}

const triage = (fb: string, body: Doc) => say('owner', 'POST', item(fb, 'triage'), body);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  providerId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  say = requester(app, { owner: await signUserToken(owner), member: await signUserToken(member) });
  requirementKey = ok(
    await say('owner', 'POST', at('/requirements'), {
      title: 'The board keeps its cards',
      reason: 'the rule the feedback states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an item delivered by several issues names every one of them', () => {
  let fb = '';
  const carriers: Issue[] = [];

  beforeAll(async () => {
    fb = await file('Saving the board loses every card');
    for (const t of ['Save the cards', 'Save the columns', 'Save the filters'])
      carriers.push(await issue(t));
    const [, second] = carriers;
    const [req] = await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(requirementKey.slice(4))}`,
    );
    await rows(sql`UPDATE issues SET requirement_id = ${req?.id} WHERE id = ${second?.id}`);
  });

  it('routes the item to each issue the list names, and reads each with its own status', async () => {
    const answered = ok(await triage(fb, { route: 'issue', issue: carriers.map((c) => c.key) }));
    expect(answered.effect).toEqual({
      feedback: fb,
      route: 'issue',
      carriers: carriers.map((c) => c.key),
    });
    const routed = await read(fb);
    expect(routed.phase).toBe('planned');
    expect(routed.route).toEqual({
      route: 'issue',
      carriers: carriers.map((c) => ({ key: c.key, status: 'open' })),
      answer: null,
    });
  });

  it('records the triage naming every carrier, and the routing on each carrier issue', async () => {
    expect((await read(fb)).decisions.at(-1)).toMatchObject({
      decision: 'triaged',
      route: 'issue',
      carrier: carriers.map((c) => c.key).join(', '),
    });
    const logged = await rows<{ issue_id: string }>(sql`
      SELECT issue_id FROM activity_log WHERE payload->>'lead' = ${`${fb} routed to this issue`}`);
    expect(logged.map((l) => l.issue_id).sort()).toEqual(carriers.map((c) => c.id).sort());
  });

  it('is listed by every carrier issue among the feedback it carries', async () => {
    for (const c of carriers) {
      const read = ok(await say('owner', 'GET', at(`/issues/standing/${c.key}`)));
      expect(read.standing.feedback, c.key).toEqual([fb]);
    }
  });

  it('is listed by the requirement one of its carriers belongs to', async () => {
    const req = ok(await say('owner', 'GET', at(`/requirements/${requirementKey}`)));
    expect(req.feedback.map((f: Doc) => [f.key, f.via.type])).toContainEqual([fb, 'route']);
  });

  it('waits on every carrier still open, each named', async () => {
    const [a, b, c] = carriers.map((x) => x.key);
    expect(await waitingOn(fb)).toMatchObject({
      kind: 'issue',
      who: `${a}, ${b} and ${c}`,
      act: 'ship',
    });
  });

  it('stays planned while one carrier is open, the others closed or dropped', async () => {
    const [a, b, c] = carriers;
    await ship(a?.id as string);
    await seedIssueStatus(b?.id as string, 'dropped');
    expect((await read(fb)).phase).toBe('planned');
    expect(await waitingOn(fb)).toMatchObject({ kind: 'issue', who: c?.key, ref: c?.key });
  });

  it('reads resolved once every carrier that is not dropped is closed', async () => {
    await ship(carriers[2]?.id as string);
    expect((await read(fb)).phase).toBe('resolved');
  });
});

describe('an item whose every carrier is dropped goes back to triage', () => {
  it('reads triaged and takes a new route', async () => {
    const fb = await file('The board flickers');
    const dropped = [await issue('Flicker one'), await issue('Flicker two')];
    ok(await triage(fb, { route: 'issue', issue: dropped.map((d) => d.key) }));
    for (const d of dropped) await seedIssueStatus(d.id, 'dropped');
    expect((await read(fb)).phase).toBe('triaged');
    const next = await issue('Flicker, for real');
    ok(await triage(fb, { route: 'issue', issue: next.key }));
    const again = await read(fb);
    expect(again.phase).toBe('planned');
    expect(again.route.carriers).toEqual([{ key: next.key, status: 'open' }]);
  });
});

describe('one issue named alone routes the item to that one issue', () => {
  it('reads one carrier', async () => {
    const fb = await file('The board loses its title');
    const only = await issue('Keep the title');
    ok(await triage(fb, { route: 'issue', issue: only.key }));
    expect((await read(fb)).route.carriers).toEqual([{ key: only.key, status: 'open' }]);
  });
});

describe('a carrier list is refused by name and writes nothing', () => {
  let fb = '';
  let named: Issue;

  beforeAll(async () => {
    fb = await file('The board forgets its order');
    named = await issue('Keep the order');
  });

  it('refuses one issue named twice, by key and by uuid', async () => {
    const r = refusal(await triage(fb, { route: 'issue', issue: [named.key, named.id] }));
    expect(r).toMatchObject({ code: 'FEEDBACK_CARRIER_REPEATED', path: '/issue/1' });
    expect(r.detail).toContain(named.key);
    const after = await read(fb);
    expect([after.phase, after.route]).toEqual(['new', null]);
  });

  it('refuses a list with one reference that names no issue here, at that entry', async () => {
    const r = refusal(await triage(fb, { route: 'issue', issue: [named.key, 'ISS-9999'] }));
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/issue/1' });
    const after = await read(fb);
    expect([after.phase, after.route]).toEqual(['new', null]);
  });

  it('refuses an empty list as an invalid body', async () => {
    const r = await triage(fb, { route: 'issue', issue: [] });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(JSON.stringify(r.json)).toContain('/issue');
    expect((await read(fb)).route).toBeNull();
  });
});

describe('the database holds an issue route to its carriers', () => {
  async function refusedBy(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
    }
    throw new Error('the write was not refused');
  }

  it('refuses an issue-routed item left with no carrier', async () => {
    const fb = await file('The board drops a card');
    ok(await triage(fb, { route: 'issue', issue: (await issue('Keep the card')).key }));
    const seq = Number(fb.slice(3));
    const said = await refusedBy(
      rows(sql`
        DELETE FROM feedback_route_issues WHERE feedback_id =
          (SELECT id FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq})`),
    );
    expect(said).toContain('FEEDBACK_ROUTE_INCOMPLETE');
    expect((await read(fb)).route.carriers).toHaveLength(1);
  });

  it('refuses a carrier on an item not routed to an issue', async () => {
    const fb = await file('The board is slow');
    const loose = await issue('Make the board fast');
    const seq = Number(fb.slice(3));
    const said = await refusedBy(
      rows(sql`
        INSERT INTO feedback_route_issues (feedback_id, issue_id)
        SELECT id, ${loose.id} FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${seq}`),
    );
    expect(said).toContain('FEEDBACK_ROUTE_TARGET_MISMATCH');
    expect((await read(fb)).route).toBeNull();
  });
});

describe('a contract change carried by several issues', () => {
  it('writes its contract wait on each of them', async () => {
    await rows(sql`
      INSERT INTO contract_versions (provider_project_id, contract_slug, version, contract_type, document, classification)
      VALUES (${providerId}, 'orders', '2.0.0', 'openapi', '{}'::jsonb, 'breaking')`);
    const [made] = await rows<{ fb_seq: number }>(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, contract_provider_project_id, contract_slug,
                            contract_version, reported_by, reporter_agency)
      SELECT ${projectId}, coalesce(max(fb_seq), 0) + 1, 'contract_change', 'orders 2.0.0 breaks',
             ${providerId}, 'orders', '2.0.0', min(reported_by::text)::uuid, 'human'
        FROM feedback WHERE project_id = ${projectId}
      RETURNING fb_seq`);
    const fb = `FB-${made?.fb_seq}`;
    const upgrades = [await issue('Upgrade the client'), await issue('Upgrade the worker')];
    ok(await triage(fb, { route: 'issue', issue: upgrades.map((u) => u.key) }));
    const waits = await rows<{ issue_id: string; min_version: string }>(sql`
      SELECT issue_id, min_version FROM issue_contract_waits
       WHERE contract_slug = 'orders' AND provider_project_id = ${providerId}`);
    expect(waits.map((w) => [w.issue_id, w.min_version]).sort()).toEqual(
      upgrades.map((u) => [u.id, '2.0.0']).sort(),
    );
  });
});
