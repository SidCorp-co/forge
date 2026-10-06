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
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

type Who = 'owner' | 'member';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherProjectId = '';
const keys = { draft: '', agreed: '', foreignReq: '', issue: '' };

const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return { code: first.code, path: first.path, detail: first.detail };
}

async function file(body: Doc): Promise<string> {
  const made = ok(
    await say('member', 'POST', at('/feedback'), { kind: 'bug', title: 'A rule', ...body }),
    201,
  );
  return made.feedback.key as string;
}

const read = async (fb: string): Promise<Doc> => ok(await say('owner', 'GET', item(fb))).feedback;

async function requirement(project: string, title: string): Promise<Doc> {
  return ok(
    await say('owner', 'POST', `/api/projects/${project}/requirements`, {
      title,
      reason: 'the rule the feedback states',
      criteria: [{ body: `${title} holds on every screen.` }],
    }),
    201,
  );
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  const member = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  otherProjectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, member, 'member');
  say = requester(app, { owner: await signUserToken(owner), member: await signUserToken(member) });
  keys.draft = (await requirement(projectId, 'Labels, never raw enum values')).key;
  const agreed = (await requirement(projectId, 'One declared schema per screen')).key;
  ok(await say('owner', 'POST', at(`/requirements/${agreed}/revisions/1/propose`), {}));
  ok(
    await say('owner', 'POST', at(`/requirements/${agreed}/revisions/1/accept`), { reason: 'ok' }),
  );
  ok(
    await say('owner', 'POST', at(`/requirements/${agreed}/agree`), { revision: 1, reason: 'ok' }),
  );
  keys.agreed = agreed;
  keys.foreignReq = (await requirement(otherProjectId, 'Another project rule')).id;
  keys.issue = ok(await say('owner', 'POST', at('/issues'), { title: 'Draw the labels' }), 201).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an item filed about a screen moves to the requirement that records its rule', () => {
  let fb = '';

  it('is refused to a member, who does not hold feedback.approve, and keeps its target', async () => {
    fb = await file({ screen: '/projects/hop/workflows' });
    const r = refusal(
      await say('member', 'POST', item(fb, 'retarget'), { requirement: keys.draft }),
    );
    expect(r.code).toBe('PERMISSION_FORBIDDEN');
    expect(r.detail).toContain('feedback.approve');
    expect((await read(fb)).target).toMatchObject({
      type: 'screen',
      key: '/projects/hop/workflows',
    });
  });

  it('refuses two targets and none, as create does, and keeps its target', async () => {
    const two = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), {
        requirement: keys.draft,
        issue: keys.issue,
      }),
    );
    expect(two).toMatchObject({ code: 'FEEDBACK_TARGET_NOT_ONE', path: '/issue' });
    const none = refusal(await say('owner', 'POST', item(fb, 'retarget'), { reason: 'no target' }));
    expect(none.code).toBe('FEEDBACK_TARGET_NOT_ONE');
    expect((await read(fb)).target.type).toBe('screen');
  });

  it('refuses a reference that names nothing here, and another project’s requirement by uuid', async () => {
    const unknown = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), { requirement: 'REQ-999' }),
    );
    expect(unknown).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/requirement' });
    const foreign = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), { requirement: keys.foreignReq }),
    );
    expect(foreign).toMatchObject({ code: 'FEEDBACK_TARGET_NOT_IN_PROJECT', path: '/requirement' });
    expect((await read(fb)).target.type).toBe('screen');
  });

  it('moves to the requirement, keeps the screen as where it was seen, and records the move', async () => {
    const moved = ok(
      await say('owner', 'POST', item(fb, 'retarget'), {
        requirement: keys.draft,
        reason: 'the rule is now a criterion',
      }),
    ).feedback;
    expect(moved.target).toMatchObject({ type: 'requirement', key: keys.draft });
    expect(moved.whereSeen).toBe('/projects/hop/workflows');
    expect(moved.decisions.at(-1)).toMatchObject({
      decision: 'retargeted',
      route: null,
      carrier: keys.draft,
      reason: `from screen “/projects/hop/workflows” to requirement ${keys.draft} · the rule is now a criterion`,
    });
  });

  it('is listed by that requirement among its feedback', async () => {
    const req = ok(await say('owner', 'GET', at(`/requirements/${keys.draft}`)));
    expect(req.feedback.map((f: Doc) => [f.key, f.via.type])).toContainEqual([fb, 'requirement']);
  });

  it('refuses the target it already has', async () => {
    const r = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), { requirement: keys.draft }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNCHANGED', path: '/requirement' });
    expect((await read(fb)).decisions.filter((d: Doc) => d.decision === 'retargeted')).toHaveLength(
      1,
    );
  });
});

describe('a verified item is retargeted with its phase and route as they were', () => {
  it('moves while verified, and still reads verified on its answer route', async () => {
    const fb = await file({ screen: 'Every screen that prints an enum' });
    ok(await say('owner', 'POST', item(fb, 'triage'), { route: 'answer', answer: 'Labels now.' }));
    ok(await say('member', 'POST', item(fb, 'verify'), {}));
    const before = await read(fb);
    expect(before.phase).toBe('verified');
    const after = ok(
      await say('owner', 'POST', item(fb, 'retarget'), { issue: keys.issue }),
    ).feedback;
    expect(after.target.type).toBe('issue');
    expect([after.status, after.phase, after.route]).toEqual([
      before.status,
      before.phase,
      before.route,
    ]);
  });
});

describe('what an item can never be moved off or onto', () => {
  it('keeps a revision-routed item on the requirement its suggestion revises', async () => {
    const fb = await file({ requirement: keys.agreed, kind: 'change_request' });
    const suggestion = ok(
      await say('owner', 'POST', at('/suggestions'), {
        kind: 'revision_diff',
        requirement: keys.agreed,
        baseRevision: 1,
        payload: { reason: 'the feedback', criteria: [{ code: 'BC-1', body: 'Changed.' }] },
      }),
      201,
    ).suggestion.id;
    ok(await say('owner', 'POST', item(fb, 'triage'), { route: 'revision', suggestion }));
    const r = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), { requirement: keys.draft }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_ROUTE_TARGET_MISMATCH', path: '/requirement' });
    expect(r.detail).toContain(`routed as a revision of ${keys.agreed}`);
    expect((await read(fb)).target.key).toBe(keys.agreed);
  });

  it('refuses a screen for an item whose reporter data was deleted', async () => {
    const fb = await file({ requirement: keys.draft });
    ok(await say('owner', 'DELETE', item(fb, 'reporter-data')));
    const r = refusal(await say('owner', 'POST', item(fb, 'retarget'), { screen: 'Settings' }));
    expect(r).toMatchObject({ code: 'FEEDBACK_ALREADY_REDACTED', path: '/screen' });
    expect((await read(fb)).target.key).toBe(keys.draft);
  });

  it('refuses an item core filed about a contract version, and offers no retarget on it', async () => {
    await rows(sql`
      INSERT INTO contract_versions (provider_project_id, contract_slug, version, contract_type, document, classification)
      VALUES (${otherProjectId}, 'orders', '2.0.0', 'openapi', '{}'::jsonb, 'breaking')`);
    const [made] = await rows<{ fb_seq: number }>(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, contract_provider_project_id, contract_slug,
                            contract_version, reported_by, reporter_agency)
      SELECT ${projectId}, coalesce(max(fb_seq), 0) + 1, 'contract_change', 'orders 2.0.0 breaks',
             ${otherProjectId}, 'orders', '2.0.0', reported_by, 'human'
        FROM feedback WHERE project_id = ${projectId}
       GROUP BY reported_by LIMIT 1
      RETURNING fb_seq`);
    const fb = `FB-${made?.fb_seq}`;
    expect((await read(fb)).can.retarget).toBe(false);
    const r = refusal(
      await say('owner', 'POST', item(fb, 'retarget'), { requirement: keys.draft }),
    );
    expect(r.code).toBe('FEEDBACK_TARGET_CORE_FILED');
    expect((await read(fb)).target.type).toBe('contract');
  });
});

describe('who is offered the act', () => {
  it('offers it to the owner and not to a member', async () => {
    const fb = await file({ screen: 'The board' });
    expect((await read(fb)).can.retarget).toBe(true);
    expect(ok(await say('member', 'GET', item(fb))).feedback.can.retarget).toBe(false);
  });
});
