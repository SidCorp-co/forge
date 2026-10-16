// GET /api/projects/:id/approvals: one list of what waits on the viewer's approve-type decision,
// each row with who asked, since when, and the buttons that decide it through the record's own route.
// The business rule under test: a row is listed only for a person who may decide it, and a suggestion
// is withdrawn or revised as the author's own act only by its author.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  refusalCodes,
  requester,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
} from '../helpers/factories.js';

let app: Awaited<typeof import('../../src/index.js')>['app'];
let ownerId: string;
let memberId: string;
let outsiderId: string;
const tokens: Record<string, string> = {};

type Who = 'owner' | 'member' | 'outsider';
const as =
  (projectId: string) =>
  (who: Who, method: string, path: string, body?: unknown): Promise<Reply> =>
    requester(app, tokens)(who, method, `/api/projects/${projectId}${path}`, body);

/** A button pressed as `who`: its body, with `reason` where the act takes one. */
const press = (who: Who, act: Doc, reason?: string): Promise<Reply> =>
  requester(app, tokens)(who, 'POST', act.path, {
    ...(act.body ?? {}),
    ...(reason === undefined ? {} : { reason }),
  });

const design = (projectId: string, flow: string): Doc => {
  const d: Doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  return d;
};

/** A preview slug's sixteen base32 letters, drawn from the id so each is its own. */
const slugOf = (id: string) =>
  [...id.replaceAll('-', '').slice(0, 16)]
    .map((c) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(c, 16)])
    .join('');

interface World {
  projectId: string;
  issueKey: string;
  ownSuggestion: string;
  previewId: string;
}

/** A project holding one of each kind a person decides, the suggestion asked by the member. */
async function world(): Promise<World> {
  const { id: projectId } = await createTestProject(ownerId);
  await addProjectMember(projectId, memberId, 'member');
  const say = as(projectId);
  const issue = await createTestIssue(projectId, ownerId, 1, {
    status: 'open',
    createdAt: new Date(Date.now() - 5 * 86_400_000),
  });

  // the member's suggestion, asked first so it has waited longest
  const suggested = ok(
    await say('member', 'POST', '/suggestions', {
      kind: 'triage',
      issue: issue.key,
      baseRevision: null,
      payload: { note: 'route this to the checkout team' },
    }),
    201,
  );
  await db.execute(
    sql`UPDATE suggestions SET created_at = now() - interval '4 days' WHERE id = ${suggested.suggestion.id}`,
  );

  ok(
    await say('member', 'POST', '/mockups', {
      target: { issue: issue.key },
      kind: 'html',
      name: 'checkout.html',
      mime: 'text/html',
      caption: 'the checkout as it should look',
      contentBase64: Buffer.from('<p>checkout</p>').toString('base64'),
    }),
    201,
  );

  const made = ok(
    await say('owner', 'POST', '/workflows', {
      baseRevision: null,
      document: design(projectId, 'post-discharge'),
    }),
    201,
  );
  ok(await say('owner', 'POST', `/workflows/${made.document.id}/design/propose`, { revision: 1 }));

  const req = ok(
    await say('owner', 'POST', '/requirements', {
      title: 'The case reaches its owner',
      reason: 'the case has to reach its owner',
      criteria: [{ body: 'The case reaches its owner.' }],
    }),
    201,
  ).key as string;
  ok(await say('owner', 'POST', `/requirements/${req}/revisions/1/propose`, {}));

  const deviceId = await createTestDevice(ownerId);
  const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
  const previewId = randomUUID();
  await db.execute(sql`
    INSERT INTO previews (id, project_id, subject_kind, issue_id, session_id, device_id, slug, state,
                          command, idle_minutes, created_by, live_at)
    SELECT ${previewId}, ${projectId}, 'issue', ${issue.id}, s.id, ${deviceId}, ${`p-${slugOf(previewId)}`},
           'live', 'pnpm dev', 30, ${memberId}, now() - interval '1 day'
      FROM agent_sessions s WHERE s.pipeline_run_id = ${runId}`);

  return {
    projectId,
    issueKey: issue.key,
    ownSuggestion: suggested.suggestion.id as string,
    previewId,
  };
}

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  await (await import('../../src/queue/boss.js')).startBoss();
  await (await import('../../src/outbox/index.js')).declareOutboxQueues();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  memberId = (await createTestUser({ verified: true })).id;
  outsiderId = (await createTestUser({ verified: true })).id;
  tokens.owner = await signUserToken(ownerId);
  tokens.member = await signUserToken(memberId);
  tokens.outsider = await signUserToken(outsiderId);
}, 120_000);

afterAll(closeWorld);

describe('GET /approvals lists what waits on the viewer, and only what they may decide', () => {
  it('gives an approver every kind, oldest first, each with who asked, since when and its acts', async () => {
    const w = await world();
    const inbox = ok(await as(w.projectId)('owner', 'GET', '/approvals'));
    const kinds = inbox.items.map((i: Doc) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['suggestion', 'mockup', 'design', 'revision', 'preview']),
    );
    expect(inbox.unreadable).toEqual([]);
    expect(inbox.total).toBe(inbox.items.length);
    // the member's suggestion was asked four days ago: nothing has waited longer
    expect(kinds[0]).toBe('suggestion');
    const since = inbox.items.map((i: Doc) => i.since as string);
    expect([...since].sort()).toEqual(since);

    const suggestion = inbox.items.find((i: Doc) => i.kind === 'suggestion');
    // titled by the issue it is on, never by its payload's note
    expect(suggestion).toMatchObject({
      key: w.issueKey,
      title: 'issue 1',
      suggestionKind: 'triage',
      askedBy: { kind: 'person' },
      opens: { kind: 'issue', key: w.issueKey },
      approve: { act: 'suggestion.accept', reason: 'optional' },
      decline: { act: 'suggestion.reject', reason: 'required' },
    });
    expect(suggestion.askedBy.name).toBeTruthy();

    const mockup = inbox.items.find((i: Doc) => i.kind === 'mockup');
    // titled by its name, never by its caption
    expect(mockup).toMatchObject({
      key: 'MK-1',
      title: 'checkout.html',
      mockupKind: 'html',
      approve: { act: 'mockup.accept' },
      decline: { act: 'mockup.return', reason: 'required' },
    });

    const designRow = inbox.items.find((i: Doc) => i.kind === 'design');
    expect(designRow).toMatchObject({
      key: 'post-discharge',
      revision: 1,
      askedBy: { kind: 'person' },
      approve: { act: 'design.decide', body: { revision: 1, decision: 'approve' } },
      decline: {
        act: 'design.decide',
        body: { revision: 1, decision: 'return' },
        reason: 'required',
      },
    });

    const revision = inbox.items.find((i: Doc) => i.kind === 'revision');
    expect(revision).toMatchObject({
      revision: 1,
      title: 'The case reaches its owner',
      approve: { act: 'revision.accept' },
      decline: { act: 'revision.return', reason: 'required' },
    });

    // the design is the same decision the home and the chat show, with the same buttons
    const decisions = ok(await as(w.projectId)('owner', 'GET', '/needs-you/decisions'));
    const owed = decisions.decisions.find((d: Doc) => d.entity === 'workflow');
    expect(owed).toMatchObject({ group: 'approve', key: 'post-discharge' });
    expect(owed.answers.map((a: Doc) => a.path)).toContain(designRow.approve.path);

    const preview = inbox.items.find((i: Doc) => i.kind === 'preview');
    expect(preview).toMatchObject({
      id: `preview:${w.previewId}`,
      key: w.issueKey,
      approve: {
        act: 'preview.approve',
        path: `/api/previews/${w.previewId}/approve`,
        reason: 'none',
      },
      decline: null,
    });
  }, 60_000);

  it('lists to a member only what they may decide: never a suggestion, mockup, revision or preview', async () => {
    const w = await world();
    const inbox = ok(await as(w.projectId)('member', 'GET', '/approvals'));
    // this project's approvals switch leaves a design to any writer, so the design is the member's to decide
    expect(inbox.items.map((i: Doc) => `${i.kind} ${i.key}`)).toEqual(['design post-discharge']);
    expect(inbox.total).toBe(1);
    // and what it lists the member can press: the route agrees they may decide it
    ok(await press('member', inbox.items[0].approve));
    expect(ok(await as(w.projectId)('member', 'GET', '/approvals'))).toMatchObject({
      items: [],
      total: 0,
    });
  }, 60_000);

  it('answers an empty inbox on a project where nothing waits', async () => {
    const { id } = await createTestProject(ownerId);
    expect(ok(await as(id)('owner', 'GET', '/approvals'))).toMatchObject({
      items: [],
      unreadable: [],
      total: 0,
    });
  });

  it('refuses a person outside the project, and a query it does not take', async () => {
    const { id } = await createTestProject(ownerId);
    expect((await as(id)('outsider', 'GET', '/approvals')).status).toBeGreaterThanOrEqual(403);
    expect((await as(id)('owner', 'GET', '/approvals?status=all')).status).toBe(400);
  });

  it('decides through the record’s own route: an accept leaves the list, a return without a reason is refused', async () => {
    const w = await world();
    const say = as(w.projectId);
    const before = ok(await say('owner', 'GET', '/approvals'));
    const suggestion = before.items.find((i: Doc) => i.kind === 'suggestion');
    ok(await press('owner', suggestion.approve));
    const mockup = before.items.find((i: Doc) => i.kind === 'mockup');
    const unexplained = await press('owner', mockup.decline);
    expect(unexplained.status).toBeGreaterThanOrEqual(400);

    const after = ok(await say('owner', 'GET', '/approvals'));
    expect(after.items.map((i: Doc) => i.id)).not.toContain(suggestion.id);
    expect(after.items.map((i: Doc) => i.id)).toContain(mockup.id);
    expect(after.total).toBe(before.total - 1);
  }, 60_000);
});

describe('a suggestion’s author revises or withdraws it; nobody else does', () => {
  it('lets the author revise without suggestions.approve: the original is withdrawn, the new one waits', async () => {
    const w = await world();
    const say = as(w.projectId);
    const revised = ok(
      await say('member', 'POST', `/suggestions/${w.ownSuggestion}/revise`, {
        payload: { note: 'route this to the payments team' },
        reason: '',
      }),
      201,
    );
    expect(revised.suggestion).toMatchObject({ status: 'proposed', revises: w.ownSuggestion });
    const [original] = (await db.execute(
      sql`SELECT status, reason FROM suggestions WHERE id = ${w.ownSuggestion}`,
    )) as unknown as { status: string; reason: string }[];
    expect(original?.status).toBe('withdrawn');
    expect(original?.reason).toContain('revised by its producer');

    const inbox = ok(await say('owner', 'GET', '/approvals'));
    const ids = inbox.items.map((i: Doc) => i.id);
    expect(ids).toContain(`suggestion:${revised.suggestion.id}`);
    expect(ids).not.toContain(`suggestion:${w.ownSuggestion}`);
  }, 60_000);

  it('refuses a member revising a suggestion somebody else asked', async () => {
    const w = await world();
    const say = as(w.projectId);
    const owners = ok(
      await say('owner', 'POST', '/suggestions', {
        kind: 'triage',
        issue: w.issueKey,
        baseRevision: null,
        payload: { note: 'the owner’s reading' },
      }),
      201,
    );
    const refused = await say('member', 'POST', `/suggestions/${owners.suggestion.id}/revise`, {
      payload: { note: 'my reading instead' },
      reason: 'I disagree',
    });
    expect(refused.status).toBe(403);
    const withdrawn = await say(
      'member',
      'POST',
      `/suggestions/${owners.suggestion.id}/withdraw`,
      {},
    );
    expect(refusalCodes(withdrawn)).toContain('SUGGESTION_WITHDRAW_FORBIDDEN');
  }, 60_000);

  it('lets the author withdraw their own, which leaves the inbox', async () => {
    const w = await world();
    const say = as(w.projectId);
    ok(await say('member', 'POST', `/suggestions/${w.ownSuggestion}/withdraw`, {}));
    const inbox = ok(await say('owner', 'GET', '/approvals'));
    expect(inbox.items.map((i: Doc) => i.id)).not.toContain(`suggestion:${w.ownSuggestion}`);
  }, 60_000);

  it('still holds a reviewer to a reason when revising another’s suggestion', async () => {
    const w = await world();
    const refused = await as(w.projectId)(
      'owner',
      'POST',
      `/suggestions/${w.ownSuggestion}/revise`,
      { payload: { note: 'route this to the owner' }, reason: '' },
    );
    expect(refusalCodes(refused)).toContain('SUGGESTION_REJECT_REASON_REQUIRED');
  }, 60_000);
});
