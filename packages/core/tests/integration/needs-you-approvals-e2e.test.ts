// GET /api/projects/:id/needs-you/decisions, the one Needs you read the Approvals page, the Dashboard,
// /attention and the menu count (REQ-48 BC-11): every approval an agent or a person asked of the viewer
// folded in beside the questions, each with the buttons that decide it through the record's own route
// and, where an agent proposed it, the proposal. The business rules under test: a decision is listed
// only for a person who may decide it; pressing its button decides it and it leaves the read; and a
// suggestion is withdrawn or revised as the author's own act only by its author.

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

/** A decision's button pressed as `who`: its body, with `reason` where the act takes one. */
const press = (who: Who, answer: Doc, reason?: string): Promise<Reply> =>
  requester(app, tokens)(who, 'POST', answer.path, {
    ...(answer.body ?? {}),
    ...(reason === undefined ? {} : { reason }),
  });

const READ = '/needs-you/decisions';
// the page's ✓ and ✕: the answer that does not decline, and the one core marks as declining (ISS-539)
const approveOf = (d: Doc): Doc => d.answers.find((a: Doc) => !a.declines);
const declineOf = (d: Doc): Doc => d.answers.find((a: Doc) => a.declines);
const acts = (d: Doc) => d.answers.map((a: Doc) => `${a.act}${a.needsReason ? ' (reason)' : ''}`);

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

describe('the Needs you read lists every approval waiting on the viewer, and only what they may decide', () => {
  it('gives an approver every kind folded into one read, each with its buttons and what it proposes', async () => {
    const w = await world();
    const read = ok(await as(w.projectId)('owner', 'GET', READ));
    expect(read.notDecisions.filter((n: Doc) => n.reason === 'unreadable')).toEqual([]);
    expect(read.total).toBe(read.decisions.length);
    const ids = read.decisions.map((d: Doc) => d.id as string);
    expect(new Set(ids).size).toBe(ids.length);

    const suggestion = read.decisions.find((d: Doc) => d.id === `suggestion:${w.ownSuggestion}`);
    // titled by the issue it is on, never by its payload's note
    expect(suggestion).toMatchObject({
      group: 'approve',
      key: w.issueKey,
      title: 'issue 1',
      opens: { kind: 'issue', key: w.issueKey },
      proposal: { verb: `Triage ${w.issueKey}`, what: 'route this to the checkout team' },
    });
    expect(acts(suggestion)).toEqual(['suggestion.accept', 'suggestion.reject (reason)']);

    const mockup = read.decisions.find((d: Doc) => d.topic === 'mockup');
    // titled by its name, never by its caption
    expect(mockup).toMatchObject({
      key: 'MK-1',
      title: 'checkout.html',
      proposal: { verb: 'Accept mockup' },
    });
    expect(acts(mockup)).toEqual(['mockup.accept', 'mockup.return (reason)']);

    const designRow = read.decisions.find((d: Doc) => d.entity === 'workflow');
    expect(designRow).toMatchObject({ group: 'approve', key: 'post-discharge', topic: 'design' });
    expect(designRow.answers.map((a: Doc) => a.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 1, decision: 'approve' }),
        expect.objectContaining({ revision: 1, decision: 'return' }),
      ]),
    );

    const revision = read.decisions.find((d: Doc) => d.entity === 'requirement');
    expect(revision.title).toContain('The case reaches its owner');
    expect(acts(revision)).toEqual(
      expect.arrayContaining(['revision.accept', 'revision.return (reason)']),
    );

    const preview = read.decisions.find((d: Doc) => d.topic === 'preview');
    expect(preview).toMatchObject({ id: `preview:${w.previewId}`, key: w.issueKey });
    expect(preview.answers).toEqual([
      expect.objectContaining({
        act: 'preview.approve',
        path: `/api/previews/${w.previewId}/approve`,
        needsReason: false,
      }),
    ]);
  }, 60_000);

  it('lists to a member only what they may decide: never a suggestion, mockup, revision or preview', async () => {
    const w = await world();
    const read = ok(await as(w.projectId)('member', 'GET', READ));
    // this project's approvals switch leaves a design to any writer, so the design is the member's to decide
    expect(read.decisions.map((d: Doc) => `${d.entity} ${d.key}`)).toEqual([
      'workflow post-discharge',
    ]);
    expect(read.total).toBe(1);
    // and what it lists the member can press: the route agrees they may decide it
    const approve = read.decisions[0].answers.find((a: Doc) => a.body?.decision === 'approve');
    ok(await press('member', approve));
    expect(ok(await as(w.projectId)('member', 'GET', READ))).toMatchObject({
      decisions: [],
      total: 0,
    });
  }, 60_000);

  it('answers an empty read on a project where nothing waits', async () => {
    const { id } = await createTestProject(ownerId);
    expect(ok(await as(id)('owner', 'GET', READ))).toMatchObject({
      decisions: [],
      notDecisions: [],
      total: 0,
    });
  });

  it('refuses a person outside the project, and a query it does not take', async () => {
    const { id } = await createTestProject(ownerId);
    expect((await as(id)('outsider', 'GET', READ)).status).toBeGreaterThanOrEqual(403);
    expect((await as(id)('owner', 'GET', `${READ}?status=all`)).status).toBe(400);
  });

  it('decides through the record’s own route: an approve leaves the read, a return without a reason is refused', async () => {
    const w = await world();
    const say = as(w.projectId);
    const before = ok(await say('owner', 'GET', READ));
    const suggestion = before.decisions.find((d: Doc) => d.id === `suggestion:${w.ownSuggestion}`);
    ok(await press('owner', approveOf(suggestion)));
    const mockup = before.decisions.find((d: Doc) => d.topic === 'mockup');
    const unexplained = await press('owner', declineOf(mockup));
    expect(unexplained.status).toBeGreaterThanOrEqual(400);

    const after = ok(await say('owner', 'GET', READ));
    expect(after.decisions.map((d: Doc) => d.id)).not.toContain(suggestion.id);
    expect(after.decisions.map((d: Doc) => d.id)).toContain(mockup.id);
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

    const read = ok(await say('owner', 'GET', READ));
    const ids = read.decisions.map((d: Doc) => d.id);
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

  it('lets the author withdraw their own, which leaves the read', async () => {
    const w = await world();
    const say = as(w.projectId);
    ok(await say('member', 'POST', `/suggestions/${w.ownSuggestion}/withdraw`, {}));
    const read = ok(await say('owner', 'GET', READ));
    expect(read.decisions.map((d: Doc) => d.id)).not.toContain(`suggestion:${w.ownSuggestion}`);
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
