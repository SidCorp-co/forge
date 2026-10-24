/**
 * ISS-585 (REQ-33 BC-2) — a decision read on its item is one somebody still stands behind, written
 * in the shape a decision takes, through the app's own routes and a real database:
 *
 * - c1: a caller's `decision` record carrying a key no decision takes is refused by name, and the
 *   refusal names every key a decision accepts; the master's `decision`, `why`, `until` still writes.
 * - c2: the writer withdraws a decision with a reason; it stops being read as live (the events read,
 *   the steward's reasoned-decision read) and the withdrawal stays on record naming who, when and why.
 *   Withdrawing twice, another writer's without `project.admin`, a record of another kind, one core
 *   wrote for an act and one written inside a comment are each refused by name.
 * - c3: a comment's intent is corrected in place: the same comment, its body kept, no second comment.
 *   The same intent, a decision on a feedback item without its fields, and another member's comment
 *   without `project.admin` are refused by name.
 *
 * @direct-test-of packages/core/src/issues/record-events/withdraw.ts
 * @direct-test-of packages/core/src/issues/record-events/routes.ts
 * @direct-test-of packages/core/src/comments/intent-edit.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { reasonedDecisionsOn } from '../../src/issues/index.js';
import { type ApiResponse, api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

const ACCEPTED = ['decision', 'why', 'until', 'reverse', 'assumption', 'serves', 'none', 'lead'];

let projectId: string;
let issueId: string;
let ownerId: string;
let owner: string;
let admin: string;
let member: string;

beforeEach(async () => {
  await truncateAll();
  const o = await createTestUser({ verified: true });
  const a = await createTestUser({ verified: true });
  const m = await createTestUser({ verified: true });
  const project = await createTestProject(o.id);
  await addProjectMember(project.id, o.id, 'member');
  await addProjectMember(project.id, a.id, 'admin');
  await addProjectMember(project.id, m.id, 'member');
  const [issue] = await rows<{ id: string }>(sql`
    INSERT INTO issues (project_id, iss_seq, title, created_by_id)
    VALUES (${project.id}, 7, 'decision-target', ${o.id})
    RETURNING id
  `);
  projectId = project.id;
  issueId = String(issue?.id);
  ownerId = o.id;
  owner = await userToken(o.id);
  admin = await userToken(a.id);
  member = await userToken(m.id);
});

const decide = (token: string, fields: { key: string; value: string }[]) =>
  api(token, 'POST', `/api/issues/${issueId}/events`, { kind: 'decision', contract: 1, fields });

const MASTER_SHAPE = [
  { key: 'decision', value: 'Hold ISS-7 one wave' },
  { key: 'why', value: 'Two runs already touch the module' },
  { key: 'until', value: '2099-01-01' },
];

const withdraw = (
  token: string,
  eventId: string,
  body: unknown = { reason: 'A probe, not a ruling' },
) => api(token, 'POST', `/api/issues/${issueId}/events/${eventId}/withdraw`, body);

const events = async (
  query = '',
): Promise<
  {
    id: string;
    kind: string;
    fields: { key: string; value: string }[];
    withdrawn?: Record<string, unknown>;
  }[]
> => {
  const res = await api(owner, 'GET', `/api/issues/${issueId}/events${query}`);
  expect(res.status).toBe(200);
  return res.body.items as never;
};

const refusal = (res: ApiResponse) =>
  (res.body.error as { refusals: { code: string; path: string; detail: string }[] }).refusals[0];

describe('c1: a decision record takes the fields a decision carries', () => {
  it('refuses an unknown key at its pointer, naming every key a decision accepts, and writes nothing', async () => {
    const res = await decide(owner, [...MASTER_SHAPE, { key: 'probe', value: 'x' }]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVENT_FIELD_UNKNOWN');
    const first = refusal(res);
    expect(first?.path).toBe('/fields/3/key');
    expect(first?.detail).toContain('`probe`');
    for (const key of ACCEPTED) expect(first?.detail).toContain(`\`${key}\``);
    expect(await events('?kind=decision')).toEqual([]);
  });

  it("writes the master's decision, why and until, and the plugin's decision, none and serves", async () => {
    expect((await decide(owner, MASTER_SHAPE)).status).toBe(201);
    const plugin = await decide(owner, [
      { key: 'decision', value: 'reading | assumption | undo' },
      { key: 'serves', value: 'c1' },
    ]);
    expect(plugin.status).toBe(201);
    expect(await events('?kind=decision')).toHaveLength(2);
  });

  it("refuses a caller who sends a key only core writes for its own acts (feedback routing's `feedback`)", async () => {
    const res = await decide(owner, [
      { key: 'lead', value: 'FB-1 routed to this issue' },
      { key: 'feedback', value: 'FB-1' },
    ]);
    expect(res.body.code).toBe('EVENT_FIELD_UNKNOWN');
    expect(refusal(res)?.path).toBe('/fields/1/key');
  });

  it('leaves every other kind as it was: a finding takes any key', async () => {
    const res = await api(owner, 'POST', `/api/issues/${issueId}/events`, {
      kind: 'finding',
      contract: 1,
      fields: [{ key: 'probe', value: 'x' }],
    });
    expect(res.status).toBe(201);
  });
});

describe('c2: a decision is withdrawn, never deleted', () => {
  it('the writer withdraws it with a reason; reads stop counting it and the withdrawal names who, when and why', async () => {
    const written = await decide(owner, MASTER_SHAPE);
    const id = String(written.body.id);
    expect((await reasonedDecisionsOn([issueId])).map((d) => d.decision)).toEqual([
      'Hold ISS-7 one wave',
    ]);

    const res = await withdraw(owner, id);
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('withdrawal');
    expect(res.body.actorId).toBe(ownerId);
    expect(res.body.fields).toEqual([
      { key: 'withdraws', value: id },
      { key: 'kind', value: 'decision' },
      { key: 'reason', value: 'A probe, not a ruling' },
    ]);

    expect(await reasonedDecisionsOn([issueId])).toEqual([]);
    expect(await events('?kind=decision')).toEqual([]);
    const all = await events();
    expect(all.map((e) => e.kind)).toEqual(['withdrawal']);

    const kept = await events('?kind=decision&withdrawn=include');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe(id);
    expect(kept[0]?.withdrawn).toMatchObject({
      by: { type: 'user', id: ownerId },
      reason: 'A probe, not a ruling',
    });

    const [row] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM activity_log WHERE id = ${id}
    `);
    expect(Number(row?.n)).toBe(1);
  });

  it('refuses a second withdraw by name, naming who withdrew it', async () => {
    const id = String((await decide(owner, MASTER_SHAPE)).body.id);
    expect((await withdraw(owner, id)).status).toBe(201);
    const again = await withdraw(owner, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EVENT_ALREADY_WITHDRAWN');
    expect((await events('?kind=withdrawal')).length).toBe(1);
  });

  it("refuses another member withdrawing someone else's decision, and lets a project admin do it", async () => {
    const id = String((await decide(owner, MASTER_SHAPE)).body.id);
    const res = await withdraw(member, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_FORBIDDEN');
    expect(await reasonedDecisionsOn([issueId])).toHaveLength(1);
    expect((await withdraw(admin, id)).status).toBe(201);
    expect(await reasonedDecisionsOn([issueId])).toEqual([]);
  });

  it('refuses a body with no reason, naming the field', async () => {
    const id = String((await decide(owner, MASTER_SHAPE)).body.id);
    const res = await withdraw(owner, id, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('reason');
  });

  it('refuses a record of another kind, and one that is not on this issue', async () => {
    const finding = await api(owner, 'POST', `/api/issues/${issueId}/events`, {
      kind: 'finding',
      contract: 1,
      fields: [{ key: 'is', value: 'x' }],
    });
    const res = await withdraw(owner, String(finding.body.id));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVENT_WITHDRAW_KIND');
    const missing = await withdraw(owner, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
  });

  it('refuses a decision core wrote for an act (a feedback routing), naming the act to undo instead', async () => {
    const [row] = await rows<{ id: string }>(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload)
      VALUES (${issueId}, 'user', ${ownerId}, 'human', 'record.decision',
              ${JSON.stringify({
                contract: 1,
                writer: 'core',
                lead: 'FB-1 routed to this issue',
                fields: [
                  { key: 'lead', value: 'FB-1 routed to this issue' },
                  { key: 'feedback', value: 'FB-1' },
                  { key: 'outcome', value: 'filed' },
                ],
              })}::jsonb)
      RETURNING id
    `);
    const res = await withdraw(owner, String(row?.id));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVENT_WITHDRAW_CORE_ACT');
  });

  it('refuses a decision written inside a comment, pointing at the comment', async () => {
    const posted = await api(owner, 'POST', `/api/issues/${issueId}/comments`, {
      intent: 'note',
      body: [
        'Held.',
        '',
        '```forge-record',
        'decision: hold',
        '```',
        '',
        '`forge-record: decision · contract 1`',
      ].join('\n'),
    });
    expect(posted.status).toBe(201);
    const [mirrored] = await events('?kind=decision');
    const res = await withdraw(owner, String(mirrored?.id));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EVENT_WITHDRAW_IN_COMMENT');
    expect(refusal(res)?.detail).toContain(String(posted.body.id));
  });
});

describe('c3: a comment intent is corrected in place', () => {
  const comment = async (token: string, intent: string, body = 'Is the hold still needed?') => {
    const res = await api(token, 'POST', `/api/issues/${issueId}/comments`, { intent, body });
    expect(res.status).toBe(201);
    return String(res.body.id);
  };
  const stored = async () =>
    rows<{ id: string; intent: string; body: string }>(sql`
      SELECT id, intent, body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at
    `);

  it('changes the intent of the same comment, keeping its body, and writes no second comment', async () => {
    const id = await comment(owner, 'question');
    const res = await api(owner, 'PATCH', `/api/comments/${id}`, { intent: 'note' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.intent).toBe('note');
    expect(await stored()).toEqual([{ id, intent: 'note', body: 'Is the hold still needed?' }]);
    const thread = await api(owner, 'GET', `/api/issues/${issueId}/comments`);
    expect(
      (thread.body.items as { id: string; intent: string }[]).map((c) => [c.id, c.intent]),
    ).toEqual([[id, 'note']]);
  });

  it('corrects a note into a decision and back, dropping no body', async () => {
    const id = await comment(owner, 'note', 'We hold ISS-7 one wave.');
    expect(
      (await api(owner, 'PATCH', `/api/comments/${id}`, { intent: 'decision' })).body.intent,
    ).toBe('decision');
    expect((await api(owner, 'PATCH', `/api/comments/${id}`, { intent: 'note' })).body.intent).toBe(
      'note',
    );
    expect(await stored()).toEqual([{ id, intent: 'note', body: 'We hold ISS-7 one wave.' }]);
  });

  it('refuses the intent the comment already has, by name', async () => {
    const id = await comment(owner, 'question');
    const res = await api(owner, 'PATCH', `/api/comments/${id}`, { intent: 'question' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMMENT_INTENT_UNCHANGED');
  });

  it('refuses an intent outside the set, naming the set', async () => {
    const id = await comment(owner, 'question');
    const res = await api(owner, 'PATCH', `/api/comments/${id}`, { intent: 'ruling' });
    expect(res.body.code).toBe('COMMENT_INTENT_UNKNOWN');
    expect(JSON.stringify(res.body)).toContain('question, decision, note');
  });

  it("refuses another member changing someone else's comment, and lets a project admin", async () => {
    const id = await comment(owner, 'question');
    const res = await api(member, 'PATCH', `/api/comments/${id}`, { intent: 'note' });
    expect(res.status).toBe(403);
    expect((await stored())[0]?.intent).toBe('question');
    expect((await api(admin, 'PATCH', `/api/comments/${id}`, { intent: 'note' })).status).toBe(200);
  });

  it('on a feedback item: a decision needs its fields, and moving off decision drops them', async () => {
    const fb = await createTestFeedback(projectId, ownerId, 1);
    const base = `/api/projects/${projectId}/feedback/${fb}/comments`;
    const posted = await api(owner, 'POST', base, {
      intent: 'note',
      body: 'Looks like a duplicate of FB-2.',
    });
    expect(posted.status).toBe(201);
    const id = String((posted.body.comment as { id: string } | undefined)?.id ?? posted.body.id);

    const bare = await api(owner, 'PATCH', `${base}/${id}`, { intent: 'decision' });
    expect(bare.status).toBe(422);
    expect(bare.body.code).toBe('COMMENT_DECISION_REQUIRED');

    const decided = await api(owner, 'PATCH', `${base}/${id}`, {
      intent: 'decision',
      decision: { decision: 'Duplicate of FB-2', reason: 'Same route, same refusal' },
    });
    expect(decided.status).toBe(200);
    const back = await api(owner, 'PATCH', `${base}/${id}`, { intent: 'note' });
    expect(back.status).toBe(200);
    const [row] = await rows<{ intent: string; decision: unknown; n: number }>(sql`
      SELECT intent, decision, (SELECT count(*)::int FROM comments WHERE feedback_id IS NOT NULL) AS n
      FROM comments WHERE id = ${id}
    `);
    expect(row).toEqual({ intent: 'note', decision: null, n: 1 });
  });
});
